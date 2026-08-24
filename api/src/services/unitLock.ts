/*
|--------------------------------------------------------------------------
| WAPDA units lock decision engine
|--------------------------------------------------------------------------
| Tracks Tuya-measured grid energy in a fixed Pakistan-time window:
| 17:00 through 05:59. At the configured kWh limit the breaker must be held
| open and auto-shift must stay disabled until 08:00.
|
| The Tuya cumulative forward_energy_total meter is the only units source.
| Instantaneous power, volts × amps, and every SEMS/inverter counter are
| deliberately excluded: an inverter-fed reading must never fabricate WAPDA
| units or trigger the lock.
|--------------------------------------------------------------------------
*/

export const UNIT_LOCK_DEFAULT_CONFIG = { enabled: true, limit_kwh: 6 } as const;
export const UNIT_LOCK_MIN_KWH = 0.1;
export const UNIT_LOCK_MAX_KWH = 50;
// Backward-compatible names for callers/tests that need the default values.
export const UNIT_LOCK_LIMIT_KWH = UNIT_LOCK_DEFAULT_CONFIG.limit_kwh;
export const UNIT_LOCK_WARNING_KWH = 5;
export const UNIT_LOCK_START_HOUR = 17;
export const UNIT_LOCK_END_HOUR = 6;
export const UNIT_LOCK_RELEASE_HOUR = 8;

const PKT_OFFSET_S = 5 * 3600;
const ENERGY_EPSILON_KWH = 0.000001;

export interface UnitLockState {
  version: 3;
  /** Limit used by the most recent decision. The live config remains authoritative. */
  limit_kwh: number;
  window_start_ts: number | null;
  window_end_ts: number | null;
  unlock_ts: number | null;
  meter_start_kwh: number | null;
  meter_last_kwh: number | null;
  meter_delta_kwh: number;
  used_kwh: number;
  last_sample_ts: number | null;
  warning_sent: boolean;
  locked: boolean;
  locked_at_ts: number | null;
  /** True only when the lock disabled an auto-shift setting that was ON. */
  restore_autoshift_on_unlock: boolean;
  command_attempts: number;
  last_command_ts: number | null;
  initialized_at_ts: number | null;
}

export interface UnitLockConfig {
  enabled: boolean;
  limit_kwh: number;
}

export interface UnitLockInput {
  nowTs: number;
  /** Tuya forward_energy_total, already scaled to kWh. */
  energyTotalKwh: number | null;
}

export type UnitLockPhase = "disabled" | "tracking" | "locked" | "release_hold" | "waiting";

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
  version: 3,
  limit_kwh: UNIT_LOCK_DEFAULT_CONFIG.limit_kwh,
  window_start_ts: null,
  window_end_ts: null,
  unlock_ts: null,
  meter_start_kwh: null,
  meter_last_kwh: null,
  meter_delta_kwh: 0,
  used_kwh: 0,
  last_sample_ts: null,
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

export function normalizeUnitLockConfig(value: unknown): UnitLockConfig {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const requested = Number(raw.limit_kwh);
  const limit = Number.isFinite(requested) && requested >= UNIT_LOCK_MIN_KWH && requested <= UNIT_LOCK_MAX_KWH
    ? Math.round(requested * 100) / 100
    : UNIT_LOCK_DEFAULT_CONFIG.limit_kwh;
  return { enabled: raw.enabled !== false, limit_kwh: limit };
}

/** Warn one unit below the limit, or at 80% for small limits. */
export function unitLockWarningKwh(limitKwh: number): number {
  const limit = normalizeUnitLockConfig({ limit_kwh: limitKwh }).limit_kwh;
  return Math.round(Math.max(UNIT_LOCK_MIN_KWH, Math.max(limit * 0.8, limit - 1)) * 100) / 100;
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
  const limit = normalizeUnitLockConfig({ limit_kwh: raw.limit_kwh }).limit_kwh;
  const meterDelta = nonNegative(raw.meter_delta_kwh);
  // Version 2 could take max(Tuya meter delta, integrated instantaneous Tuya
  // power). Discard that estimator and any lock it alone caused.
  const meterLocked = raw.locked === true && (
    raw.version === 3 || meterDelta + ENERGY_EPSILON_KWH >= limit
  );
  return {
    version: 3,
    limit_kwh: limit,
    window_start_ts: finiteOrNull(raw.window_start_ts),
    window_end_ts: finiteOrNull(raw.window_end_ts),
    unlock_ts: finiteOrNull(raw.unlock_ts),
    meter_start_kwh: finiteOrNull(raw.meter_start_kwh),
    meter_last_kwh: finiteOrNull(raw.meter_last_kwh),
    meter_delta_kwh: meterDelta,
    used_kwh: meterDelta,
    last_sample_ts: finiteOrNull(raw.last_sample_ts),
    warning_sent: raw.warning_sent === true && meterDelta + ENERGY_EPSILON_KWH >= unitLockWarningKwh(limit),
    locked: meterLocked,
    locked_at_ts: meterLocked ? finiteOrNull(raw.locked_at_ts) : null,
    restore_autoshift_on_unlock: raw.restore_autoshift_on_unlock === true,
    command_attempts: Math.max(0, Math.floor(nonNegative(raw.command_attempts))),
    last_command_ts: finiteOrNull(raw.last_command_ts),
    initialized_at_ts: finiteOrNull(raw.initialized_at_ts),
  };
}

function startWindow(
  state: UnitLockState,
  window: UnitLockWindow,
  input: UnitLockInput,
  config: UnitLockConfig,
): UnitLockState {
  const meter = finiteOrNull(input.energyTotalKwh);
  return {
    ...EMPTY_UNIT_LOCK_STATE,
    limit_kwh: config.limit_kwh,
    window_start_ts: window.start,
    window_end_ts: window.end,
    unlock_ts: window.unlock,
    meter_start_kwh: meter,
    meter_last_kwh: meter,
    last_sample_ts: input.nowTs,
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

  next.used_kwh = next.meter_delta_kwh;
  next.last_sample_ts = input.nowTs;
  return next;
}

export function isUnitLockEnforced(state: UnitLockState | null, nowTs: number, enabled = true): boolean {
  const normalized = normalizeUnitLockState(state);
  return enabled && normalized.locked && (normalized.unlock_ts == null || nowTs < normalized.unlock_ts);
}

/** Pure state transition for one Tuya sample. */
export function planUnitLock(
  current: UnitLockState | null,
  input: UnitLockInput,
  configValue: Partial<UnitLockConfig> | null = UNIT_LOCK_DEFAULT_CONFIG,
): UnitLockPlan {
  const config = normalizeUnitLockConfig(configValue);
  const warningKwh = unitLockWarningKwh(config.limit_kwh);
  const window = unitLockWindow(input.nowTs);
  let state = normalizeUnitLockState(current);
  // A v2 false lock may normalize to unlocked while still carrying the marker
  // that says Units Lock disabled auto-shift. Treat that as a release so the
  // user's previous automation setting is repaired on the first v3 tick.
  let justUnlocked = !state.locked && state.restore_autoshift_on_unlock;
  let justStarted = false;

  if (!config.enabled) {
    const hadLockControl = state.locked || state.restore_autoshift_on_unlock;
    state = {
      ...EMPTY_UNIT_LOCK_STATE,
      limit_kwh: config.limit_kwh,
      // Keep this only long enough for reconcileUnitLockAutoshift to restore
      // a setting Units Lock previously turned off.
      restore_autoshift_on_unlock: state.restore_autoshift_on_unlock,
    };
    return {
      state,
      phase: "disabled",
      just_started: false,
      warning_reached: false,
      just_locked: false,
      just_unlocked: hadLockControl,
      enforce_off: false,
    };
  }

  if (state.limit_kwh !== config.limit_kwh) {
    // Re-evaluate warning/lock thresholds immediately on the next minute tick.
    // A limit increase never releases an existing lock before 08:00.
    state = { ...state, limit_kwh: config.limit_kwh, warning_sent: false };
  }

  if (state.locked && state.unlock_ts != null && input.nowTs >= state.unlock_ts) {
    state = { ...state, locked: false, command_attempts: 0, last_command_ts: null };
    justUnlocked = true;
  }

  if (window.active && state.window_start_ts !== window.start) {
    state = startWindow(state, window, input, config);
    justStarted = true;
  } else if (state.window_start_ts === window.start) {
    // If the first poll after 06:00 is a minute or two late, count the final
    // Tuya meter increment conservatively before freezing the finished window.
    const shouldFinishLastSample =
      !window.active && state.last_sample_ts != null && state.last_sample_ts < window.end;
    if (window.active || shouldFinishLastSample) state = accumulate(state, input);
  }

  const warningReached =
    !state.locked && !state.warning_sent && state.used_kwh + ENERGY_EPSILON_KWH >= warningKwh;
  if (warningReached) state = { ...state, warning_sent: true };

  const justLocked =
    !state.locked &&
    state.used_kwh + ENERGY_EPSILON_KWH >= config.limit_kwh &&
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

  const enforceOff = isUnitLockEnforced(state, input.nowTs, config.enabled);
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

export interface UnitLockAutoshiftPlan {
  state: UnitLockState;
  enabled: boolean;
  settings_changed: boolean;
  disabled_by_lock: boolean;
  restored_at_release: boolean;
}

/** Pure reconciliation so the safety-critical OFF/08:00 restore behavior is testable. */
export function reconcileUnitLockAutoshift(
  stateValue: UnitLockState,
  plan: Pick<UnitLockPlan, "enforce_off" | "just_unlocked">,
  autoshiftEnabled: boolean,
): UnitLockAutoshiftPlan {
  let state = normalizeUnitLockState(stateValue);
  let enabled = autoshiftEnabled;
  let disabledByLock = false;
  let restoredAtRelease = false;

  if (plan.just_unlocked) {
    if (state.restore_autoshift_on_unlock && !enabled) {
      enabled = true;
      restoredAtRelease = true;
    }
    state = { ...state, restore_autoshift_on_unlock: false };
  }

  if (plan.enforce_off && enabled) {
    state = { ...state, restore_autoshift_on_unlock: true };
    enabled = false;
    disabledByLock = true;
  }

  return {
    state,
    enabled,
    settings_changed: enabled !== autoshiftEnabled,
    disabled_by_lock: disabledByLock,
    restored_at_release: restoredAtRelease,
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
