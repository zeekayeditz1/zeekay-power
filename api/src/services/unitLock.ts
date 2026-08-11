/*
|--------------------------------------------------------------------------
| WAPDA units lock decision engine
|--------------------------------------------------------------------------
| Tracks Tuya-measured grid energy in a fixed Pakistan-time window:
| 17:00 through 05:59. At 6.00 kWh the breaker must be held open and
| auto-shift must stay disabled until 08:00. A warning is raised at 5.00 kWh.
|
| The Tuya cumulative energy meter is authoritative. Minute-by-minute Tuya
| active power is integrated as a conservative fallback/cross-check so the
| lock continues working if that meter is temporarily missing or updates in
| coarse 0.01 kWh steps. No inverter power field is used by this controller.
|--------------------------------------------------------------------------
*/

export const UNIT_LOCK_LIMIT_KWH = 6;
export const UNIT_LOCK_WARNING_KWH = 5;
export const UNIT_LOCK_START_HOUR = 17;
export const UNIT_LOCK_END_HOUR = 6;
export const UNIT_LOCK_RELEASE_HOUR = 8;

const PKT_OFFSET_S = 5 * 3600;
const MAX_INTEGRATION_GAP_S = 5 * 60;
const ENERGY_EPSILON_KWH = 0.000001;

export interface UnitLockState {
  version: 1;
  window_start_ts: number | null;
  window_end_ts: number | null;
  unlock_ts: number | null;
  meter_start_kwh: number | null;
  meter_last_kwh: number | null;
  meter_delta_kwh: number;
  integrated_kwh: number;
  used_kwh: number;
  last_sample_ts: number | null;
  last_power_w: number | null;
  warning_sent: boolean;
  locked: boolean;
  locked_at_ts: number | null;
  /** True only when the lock disabled an auto-shift setting that was ON. */
  restore_autoshift_on_unlock: boolean;
  command_attempts: number;
  last_command_ts: number | null;
  initialized_at_ts: number | null;
}

export interface UnitLockInput {
  nowTs: number;
  /** Tuya forward_energy_total, already scaled to kWh. */
  energyTotalKwh: number | null;
  /** Tuya active power from phase_a. */
  powerW: number | null;
  /** Tuya mains-side voltage/current, used only if active power is absent. */
  voltageV?: number | null;
  currentA?: number | null;
}

export type UnitLockPhase = "tracking" | "locked" | "release_hold" | "waiting";

export interface UnitLockPlan {
  state: UnitLockState;
  phase: UnitLockPhase;
  just_started: boolean;
  warning_reached: boolean;
  just_locked: boolean;
  just_unlocked: boolean;
  enforce_off: boolean;
}

export const EMPTY_UNIT_LOCK_STATE: UnitLockState = {
  version: 1,
  window_start_ts: null,
  window_end_ts: null,
  unlock_ts: null,
  meter_start_kwh: null,
  meter_last_kwh: null,
  meter_delta_kwh: 0,
  integrated_kwh: 0,
  used_kwh: 0,
  last_sample_ts: null,
  last_power_w: null,
  warning_sent: false,
  locked: false,
  locked_at_ts: null,
  restore_autoshift_on_unlock: false,
  command_attempts: 0,
  last_command_ts: null,
  initialized_at_ts: null,
};

interface UnitLockWindow {
  start: number;
  end: number;
  unlock: number;
  active: boolean;
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Fixed Pakistan-time window containing now, or the most recently completed
 * window during the daytime gap. Pakistan is UTC+5 and has no DST. */
export function unitLockWindow(epochSeconds: number): UnitLockWindow {
  const local = new Date((epochSeconds + PKT_OFFSET_S) * 1000);
  const localMidnight =
    Math.floor(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) / 1000) -
    PKT_OFFSET_S;
  const hour = local.getUTCHours();

  if (hour >= UNIT_LOCK_START_HOUR) {
    const start = localMidnight + UNIT_LOCK_START_HOUR * 3600;
    return {
      start,
      end: localMidnight + 24 * 3600 + UNIT_LOCK_END_HOUR * 3600,
      unlock: localMidnight + 24 * 3600 + UNIT_LOCK_RELEASE_HOUR * 3600,
      active: true,
    };
  }

  const start = localMidnight - (24 - UNIT_LOCK_START_HOUR) * 3600;
  return {
    start,
    end: localMidnight + UNIT_LOCK_END_HOUR * 3600,
    unlock: localMidnight + UNIT_LOCK_RELEASE_HOUR * 3600,
    active: hour < UNIT_LOCK_END_HOUR,
  };
}

export function normalizeUnitLockState(value: unknown): UnitLockState {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    version: 1,
    window_start_ts: finiteOrNull(raw.window_start_ts),
    window_end_ts: finiteOrNull(raw.window_end_ts),
    unlock_ts: finiteOrNull(raw.unlock_ts),
    meter_start_kwh: finiteOrNull(raw.meter_start_kwh),
    meter_last_kwh: finiteOrNull(raw.meter_last_kwh),
    meter_delta_kwh: nonNegative(raw.meter_delta_kwh),
    integrated_kwh: nonNegative(raw.integrated_kwh),
    used_kwh: nonNegative(raw.used_kwh),
    last_sample_ts: finiteOrNull(raw.last_sample_ts),
    last_power_w: finiteOrNull(raw.last_power_w),
    warning_sent: raw.warning_sent === true,
    locked: raw.locked === true,
    locked_at_ts: finiteOrNull(raw.locked_at_ts),
    restore_autoshift_on_unlock: raw.restore_autoshift_on_unlock === true,
    command_attempts: Math.max(0, Math.floor(nonNegative(raw.command_attempts))),
    last_command_ts: finiteOrNull(raw.last_command_ts),
    initialized_at_ts: finiteOrNull(raw.initialized_at_ts),
  };
}

function tuyaPower(input: UnitLockInput): number | null {
  const direct = finiteOrNull(input.powerW);
  if (direct != null) return Math.max(0, direct);
  const voltage = finiteOrNull(input.voltageV);
  const current = finiteOrNull(input.currentA);
  return voltage != null && current != null ? Math.max(0, voltage * current) : null;
}

function startWindow(state: UnitLockState, window: UnitLockWindow, input: UnitLockInput): UnitLockState {
  const meter = finiteOrNull(input.energyTotalKwh);
  return {
    ...EMPTY_UNIT_LOCK_STATE,
    window_start_ts: window.start,
    window_end_ts: window.end,
    unlock_ts: window.unlock,
    meter_start_kwh: meter,
    meter_last_kwh: meter,
    last_sample_ts: input.nowTs,
    last_power_w: tuyaPower(input),
    // Preserve a pending restore if the controller was offline past 08:00 and
    // only woke when a new evening window had already begun.
    restore_autoshift_on_unlock: state.restore_autoshift_on_unlock,
    initialized_at_ts: input.nowTs,
  };
}

function accumulate(state: UnitLockState, input: UnitLockInput): UnitLockState {
  const next = { ...state };
  const meter = finiteOrNull(input.energyTotalKwh);
  if (meter != null) {
    if (next.meter_start_kwh == null) next.meter_start_kwh = meter;
    if (next.meter_last_kwh != null && meter >= next.meter_last_kwh) {
      next.meter_delta_kwh += meter - next.meter_last_kwh;
    }
    // A Tuya counter reset must never erase energy already counted. The new
    // reading becomes the next baseline and accumulation continues forward.
    next.meter_last_kwh = meter;
  }

  const power = tuyaPower(input);
  if (next.last_sample_ts != null && power != null) {
    const rawDt = Math.max(0, input.nowTs - next.last_sample_ts);
    const dt = Math.min(MAX_INTEGRATION_GAP_S, rawDt);
    const previousPower = next.last_power_w ?? power;
    next.integrated_kwh += ((Math.max(0, previousPower) + power) / 2) * dt / 3_600_000;
  }

  next.used_kwh = Math.max(next.used_kwh, next.meter_delta_kwh, next.integrated_kwh);
  next.last_sample_ts = input.nowTs;
  next.last_power_w = power;
  return next;
}

export function isUnitLockEnforced(state: UnitLockState | null, nowTs: number): boolean {
  const normalized = normalizeUnitLockState(state);
  return normalized.locked && (normalized.unlock_ts == null || nowTs < normalized.unlock_ts);
}

/** Pure state transition for one Tuya sample. */
export function planUnitLock(current: UnitLockState | null, input: UnitLockInput): UnitLockPlan {
  const window = unitLockWindow(input.nowTs);
  let state = normalizeUnitLockState(current);
  let justUnlocked = false;
  let justStarted = false;

  if (state.locked && state.unlock_ts != null && input.nowTs >= state.unlock_ts) {
    state = { ...state, locked: false, command_attempts: 0, last_command_ts: null };
    justUnlocked = true;
  }

  if (window.active && state.window_start_ts !== window.start) {
    state = startWindow(state, window, input);
    justStarted = true;
  } else if (state.window_start_ts === window.start) {
    // If the first poll after 06:00 is a minute or two late, count the final
    // Tuya meter increment conservatively before freezing the finished window.
    const shouldFinishLastSample =
      !window.active && state.last_sample_ts != null && state.last_sample_ts < window.end;
    if (window.active || shouldFinishLastSample) state = accumulate(state, input);
  }

  const warningReached =
    !state.warning_sent && state.used_kwh + ENERGY_EPSILON_KWH >= UNIT_LOCK_WARNING_KWH;
  if (warningReached) state = { ...state, warning_sent: true };

  const justLocked =
    !state.locked &&
    state.used_kwh + ENERGY_EPSILON_KWH >= UNIT_LOCK_LIMIT_KWH &&
    input.nowTs < window.unlock;
  if (justLocked) {
    state = {
      ...state,
      locked: true,
      locked_at_ts: input.nowTs,
      command_attempts: 0,
      last_command_ts: null,
    };
  }

  const enforceOff = isUnitLockEnforced(state, input.nowTs);
  const phase: UnitLockPhase = enforceOff
    ? (window.active ? "locked" : "release_hold")
    : window.active ? "tracking" : "waiting";

  return {
    state,
    phase,
    just_started: justStarted,
    warning_reached: warningReached,
    just_locked: justLocked,
    just_unlocked: justUnlocked,
    enforce_off: enforceOff,
  };
}

const RETRY_BACKOFF_S = [0, 60, 180, 420, 600];

export function mayRetryUnitLockOff(state: UnitLockState, nowTs: number): boolean {
  if (state.last_command_ts == null) return true;
  const index = Math.min(state.command_attempts, RETRY_BACKOFF_S.length - 1);
  return nowTs - state.last_command_ts >= RETRY_BACKOFF_S[index];
}

export function recordUnitLockOffAttempt(state: UnitLockState, nowTs: number): UnitLockState {
  return {
    ...state,
    command_attempts: state.command_attempts + 1,
    last_command_ts: nowTs,
  };
}

export function recordUnitLockOffConfirmed(state: UnitLockState): UnitLockState {
  return { ...state, command_attempts: 0, last_command_ts: null };
}
