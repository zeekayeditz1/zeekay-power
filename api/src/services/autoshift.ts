/*
|--------------------------------------------------------------------------
| Auto-shift-to-WAPDA decision engine
|--------------------------------------------------------------------------
| Pure, side-effect-free planner for the voltage-triggered "borrow WAPDA for a
| while so the battery doesn't sit flat overnight" automation.
|
| Everything that talks to hardware lives in socPipeline.ts; this module only
| answers one question: given the current config, the stored state and this
| tick's telemetry, what should the relay be doing? Keeping it pure is what
| makes the behaviour testable — the state machine can be replayed against a
| recorded night without a Tuya breaker anywhere in sight.
|
|--------------------------------------------------------------------------
| Relay protection (the reason this file is shaped the way it is)
|--------------------------------------------------------------------------
| The breaker is a physical contactor switching mains into a hybrid inverter.
| Every operation costs contact life, and rapid open/close cycling is hard on
| the inverter's transfer relay too. So the planner is built around four rules
| that together make chatter structurally impossible:
|
|   1. NEVER START INTO A STOP. Arming is only allowed when no stop condition
|      already holds. Previously the cycle could arm at 18:02 while PV was
|      still 355 W, immediately trip the "PV recovered" stop, and re-arm on the
|      next tick — an oscillator that produced ON/OFF pairs every two minutes
|      until sunset.
|   2. STOP CONDITIONS OUTRANK RE-ASSERTS. The window/PV/duration checks run
|      for every active phase before any decision to (re)close the relay.
|      Previously "window ended" only applied while waiting for grid, so at
|      06:00 a charging cycle would first re-close the relay and only open it
|      again a minute later.
|   3. DON'T FIGHT ANYONE ELSE. If the breaker was confirmed closed by us and
|      then opens on its own — a Tuya app schedule, a manual switch, mains
|      cycling a breaker whose power-on state is OFF — the cycle ends. It does
|      not slam the relay shut again 60 seconds later.
|   4. DWELL AND COOL DOWN. Once closed, the relay stays closed for a minimum
|      time; once a cycle ends, no new cycle may start for a cooldown period.
|      Retries of an unconfirmed command back off instead of firing every
|      minute forever.
|--------------------------------------------------------------------------
*/

export type AutoshiftPhase = "idle" | "waiting_for_grid" | "charging" | "stopping";
export type AutoshiftStopReason =
  | "disabled"
  | "window_ended"
  | "pv_recovered"
  | "duration_complete"
  | "external_override"
  | "unit_limit";

export interface AutoshiftConfig {
  enabled: boolean;
  threshold_v: number;
  duration_min: number;
  pv_stop_w: number;
  /** Minimum minutes the relay stays closed once auto-shift closed it. */
  min_on_min: number;
  /** Minimum minutes between the end of one cycle and the start of the next. */
  cooldown_min: number;
}

export interface AutoshiftState {
  phase: AutoshiftPhase;
  trigger_ts: number | null;
  trigger_voltage: number | null;
  charge_start_ts: number | null;
  until_ts: number | null;
  stop_reason: AutoshiftStopReason | null;
  /** When THIS cycle first saw the breaker confirmed closed. Null means our
   *  ON command has not landed yet, which is what separates "the command
   *  failed" from "someone else opened it". */
  relay_closed_ts: number | null;
  /** When the last cycle went idle — drives the cooldown. Survives across
   *  cycles, so it is deliberately preserved when the state resets to idle. */
  last_end_ts: number | null;
  /** Consecutive relay commands issued without the breaker confirming. */
  command_attempts: number;
  last_command_ts: number | null;
}

export interface GridSignals {
  relayOn: boolean;
  tuyaOnline: boolean | null;
  semsGridPower?: number | null;
  tuyaGridPower?: number | null;
  tuyaGridVoltage?: number | null;
}

export interface AutoshiftInput {
  nowTs: number;
  batteryVoltage: number;
  pvPower: number;
  inNightWindow: boolean;
  gridConnected: boolean;
  relayOn: boolean;
}

export type AutoshiftCommand = "on" | "off" | null;
export type AutoshiftTransition =
  | "started_waiting"
  | "grid_confirmed"
  | "grid_lost"
  | "stop_requested"
  | "stopped"
  | "external_override";

export interface AutoshiftPlan {
  state: AutoshiftState;
  command: AutoshiftCommand;
  transition: AutoshiftTransition | null;
}

export const AUTOSHIFT_DEFAULT: AutoshiftConfig = {
  enabled: false,
  threshold_v: 45.8,
  duration_min: 60,
  pv_stop_w: 200,
  min_on_min: 15,
  cooldown_min: 30,
};

export const EMPTY_AUTOSHIFT_STATE: AutoshiftState = {
  phase: "idle",
  trigger_ts: null,
  trigger_voltage: null,
  charge_start_ts: null,
  until_ts: null,
  stop_reason: null,
  relay_closed_ts: null,
  last_end_ts: null,
  command_attempts: 0,
  last_command_ts: null,
};

/* Wait this long before re-sending a relay command that has not been confirmed.
   Indexed by how many attempts have already been made; the last entry repeats.
   Replaces the previous behaviour of re-issuing the command every single
   minute, which on 2026-08-08 produced 58 consecutive ON commands in an hour. */
const RETRY_BACKOFF_S = [0, 60, 180, 420, 600];

/** Stop reasons that must act immediately, ignoring the minimum-ON dwell:
 *  the user switched the feature off, or the night window closed. */
const IMMEDIATE_STOP_REASONS: AutoshiftStopReason[] = ["disabled", "window_ended", "external_override"];

function backoffFor(attempts: number): number {
  if (attempts <= 0) return 0;
  return RETRY_BACKOFF_S[Math.min(attempts, RETRY_BACKOFF_S.length - 1)];
}

/** Is mains power physically present on the WAPDA line? Measured at the Tuya
 *  breaker (which sits on the mains side) or by the inverter actually importing.
 *  Deliberately does NOT look at inverter output voltage — that is present even
 *  on pure battery and proves nothing about the grid. */
export function isMainsAvailable(signals: GridSignals): boolean {
  const semsPower = Math.abs(signals.semsGridPower ?? 0);
  const tuyaPower = Math.abs(signals.tuyaGridPower ?? 0);
  const tuyaVoltage = signals.tuyaGridVoltage ?? 0;
  return semsPower > 20 || tuyaPower > 20 || tuyaVoltage > 50;
}

/** Is WAPDA actually feeding the house right now? Mains present AND the
 *  breaker closed AND the breaker reachable. */
export function isGridConnected(signals: GridSignals): boolean {
  return signals.relayOn && signals.tuyaOnline !== false && isMainsAvailable(signals);
}

/** 18:00 through 05:59, Pakistan local time (UTC+5, no DST). */
export function isPakistanNightWindow(epochSeconds: number): boolean {
  const localHour = new Date((epochSeconds + 5 * 3600) * 1000).getUTCHours();
  return localHour >= 18 || localHour < 6;
}

function clampInt(value: any, lo: number, hi: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  return rounded >= lo && rounded <= hi ? rounded : fallback;
}

export function normalizeAutoshiftConfig(value: any): AutoshiftConfig {
  const raw = value && typeof value === "object" ? value : {};
  const threshold = Number(raw.threshold_v);
  const duration = Number(raw.duration_min);
  const pvStop = Number(raw.pv_stop_w);
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : AUTOSHIFT_DEFAULT.enabled,
    threshold_v:
      Number.isFinite(threshold) && threshold >= 40 && threshold <= 58
        ? Math.round(threshold * 10) / 10
        : AUTOSHIFT_DEFAULT.threshold_v,
    duration_min:
      Number.isInteger(duration) && duration >= 5 && duration <= 360
        ? duration
        : AUTOSHIFT_DEFAULT.duration_min,
    pv_stop_w:
      Number.isFinite(pvStop) && pvStop >= 50 && pvStop <= 2000
        ? Math.round(pvStop)
        : AUTOSHIFT_DEFAULT.pv_stop_w,
    min_on_min: clampInt(raw.min_on_min, 0, 120, AUTOSHIFT_DEFAULT.min_on_min),
    cooldown_min: clampInt(raw.cooldown_min, 0, 240, AUTOSHIFT_DEFAULT.cooldown_min),
  };
}

function finiteOrNull(value: any): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeAutoshiftState(value: any): AutoshiftState {
  if (!value || typeof value !== "object") return { ...EMPTY_AUTOSHIFT_STATE };
  const raw = value;

  // Migrate the pre-state-machine {active:boolean} shape.
  if (typeof raw.phase !== "string") {
    return raw.active
      ? {
          ...EMPTY_AUTOSHIFT_STATE,
          phase: "charging",
          trigger_ts: finiteOrNull(raw.trigger_ts),
          trigger_voltage: finiteOrNull(raw.trigger_voltage),
          charge_start_ts: finiteOrNull(raw.trigger_ts),
          until_ts: finiteOrNull(raw.until_ts),
        }
      : { ...EMPTY_AUTOSHIFT_STATE };
  }

  const validPhases: AutoshiftPhase[] = ["idle", "waiting_for_grid", "charging", "stopping"];
  const phase: AutoshiftPhase = validPhases.includes(raw.phase) ? raw.phase : "idle";
  const validReasons: AutoshiftStopReason[] = [
    "disabled",
    "window_ended",
    "pv_recovered",
    "duration_complete",
    "external_override",
    "unit_limit",
  ];
  const stop_reason: AutoshiftStopReason | null = validReasons.includes(raw.stop_reason) ? raw.stop_reason : null;
  const attempts = Number(raw.command_attempts);

  return {
    phase,
    trigger_ts: finiteOrNull(raw.trigger_ts),
    trigger_voltage: finiteOrNull(raw.trigger_voltage),
    charge_start_ts: finiteOrNull(raw.charge_start_ts),
    until_ts: finiteOrNull(raw.until_ts),
    stop_reason,
    // Pre-upgrade states have no relay_closed_ts. Treating a charging cycle as
    // "already confirmed closed" is the safe reading: it means the very first
    // externally-opened relay ends the cycle instead of being re-closed.
    relay_closed_ts:
      finiteOrNull(raw.relay_closed_ts) ??
      (phase === "charging" ? finiteOrNull(raw.charge_start_ts) ?? finiteOrNull(raw.trigger_ts) : null),
    last_end_ts: finiteOrNull(raw.last_end_ts),
    command_attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0,
    last_command_ts: finiteOrNull(raw.last_command_ts),
  };
}

/** Reset to idle while KEEPING the cross-cycle cooldown clock. */
function idleState(state: AutoshiftState, endedAt: number): AutoshiftState {
  return { ...EMPTY_AUTOSHIFT_STATE, last_end_ts: endedAt ?? state.last_end_ts };
}

/** Why an active cycle should end, or null to keep going. */
function stopReason(
  cfg: AutoshiftConfig,
  input: AutoshiftInput,
  state: AutoshiftState
): AutoshiftStopReason | null {
  if (!cfg.enabled) return "disabled";
  // Applies to EVERY active phase, including charging. A cycle must not run
  // past 06:00 into daylight, and must not re-close the relay on its way out.
  if (!input.inNightWindow) return "window_ended";
  if (input.pvPower >= cfg.pv_stop_w) return "pv_recovered";
  if (state.phase === "charging" && input.nowTs >= (state.until_ts ?? 0)) return "duration_complete";
  return null;
}

/** True when a stop is wanted but the relay has not yet served its minimum
 *  closed time. Capped by duration_min so a short configured hold is never
 *  extended by the dwell. */
function heldByMinimumOn(cfg: AutoshiftConfig, input: AutoshiftInput, state: AutoshiftState): boolean {
  if (!input.relayOn || state.relay_closed_ts == null) return false;
  const minOnSeconds = Math.min(cfg.min_on_min, cfg.duration_min) * 60;
  if (minOnSeconds <= 0) return false;
  return input.nowTs - state.relay_closed_ts < minOnSeconds;
}

function issueCommand(
  state: AutoshiftState,
  input: AutoshiftInput,
  command: Exclude<AutoshiftCommand, null>,
  transition: AutoshiftTransition | null
): AutoshiftPlan {
  return {
    state: { ...state, command_attempts: state.command_attempts + 1, last_command_ts: input.nowTs },
    command,
    transition,
  };
}

/** Has enough time passed since the last unconfirmed command to try again? */
function mayRetry(state: AutoshiftState, input: AutoshiftInput): boolean {
  if (state.last_command_ts == null) return true;
  return input.nowTs - state.last_command_ts >= backoffFor(state.command_attempts);
}

export function planAutoshift(
  config: AutoshiftConfig,
  current: AutoshiftState | null,
  input: AutoshiftInput
): AutoshiftPlan {
  const normalized = normalizeAutoshiftState(current);

  // ---- reconcile the stored state with what the breaker actually reports ----
  const state: AutoshiftState = { ...normalized };
  if (state.phase !== "idle") {
    if (input.relayOn && state.phase !== "stopping") {
      // Our ON has landed (or the breaker was already closed): remember when,
      // and stop counting retries.
      if (state.relay_closed_ts == null) state.relay_closed_ts = input.nowTs;
      state.command_attempts = 0;
      state.last_command_ts = null;
    } else if (!input.relayOn && state.phase === "stopping") {
      state.command_attempts = 0;
      state.last_command_ts = null;
    }
  }

  // ---- stopping: keep asking for OFF until the breaker reads back open ----
  if (state.phase === "stopping") {
    if (!input.relayOn) {
      return { state: idleState(state, input.nowTs), command: null, transition: "stopped" };
    }
    if (!mayRetry(state, input)) return { state, command: null, transition: null };
    return issueCommand(state, input, "off", null);
  }

  // ---- idle: decide whether to start a cycle at all ----
  if (state.phase === "idle") {
    const cooldownSeconds = config.cooldown_min * 60;
    const cooledDown =
      state.last_end_ts == null || input.nowTs - state.last_end_ts >= cooldownSeconds;

    const wantsPower = config.enabled && input.inNightWindow && input.batteryVoltage <= config.threshold_v;
    // Rule 1: refuse to start if a stop condition already holds. Arming while
    // PV is above the stop threshold is what caused the 18:02/18:04/18:08
    // ON/OFF bursts.
    const stopAlreadyHolds = input.pvPower >= config.pv_stop_w;

    if (wantsPower && cooledDown && !stopAlreadyHolds && !input.relayOn) {
      return issueCommand(
        {
          ...EMPTY_AUTOSHIFT_STATE,
          phase: "waiting_for_grid",
          trigger_ts: input.nowTs,
          trigger_voltage: input.batteryVoltage,
          last_end_ts: state.last_end_ts,
        },
        input,
        "on",
        "started_waiting"
      );
    }
    return { state, command: null, transition: null };
  }

  // ---- active cycle: stop conditions are evaluated FIRST, every phase ----
  let reason = stopReason(config, input, state);
  if (reason && !IMMEDIATE_STOP_REASONS.includes(reason) && heldByMinimumOn(config, input, state)) {
    // Rule 4: the relay has not served its minimum closed time yet. Hold.
    reason = null;
  }

  if (reason) {
    if (!input.relayOn) {
      // Already open — finish without touching the relay at all. This is the
      // 06:00 case: the breaker went open on its own, the window has ended,
      // so the cycle simply ends. No ON, no OFF, no chatter.
      return {
        state: { ...idleState(state, input.nowTs), stop_reason: reason },
        command: null,
        transition: "stopped",
      };
    }
    const stopping: AutoshiftState = { ...state, phase: "stopping", until_ts: null, stop_reason: reason };
    if (!mayRetry(state, input)) return { state: stopping, command: null, transition: "stop_requested" };
    return issueCommand(stopping, input, "off", "stop_requested");
  }

  // ---- Rule 3: the breaker is open but we already had it closed this cycle ----
  if (!input.relayOn && state.relay_closed_ts != null) {
    return {
      state: { ...idleState(state, input.nowTs), stop_reason: "external_override" },
      command: null,
      transition: "external_override",
    };
  }

  if (state.phase === "waiting_for_grid") {
    if (input.gridConnected) {
      return {
        state: {
          ...state,
          phase: "charging",
          charge_start_ts: input.nowTs,
          until_ts: input.nowTs + config.duration_min * 60,
          stop_reason: null,
        },
        command: null,
        transition: "grid_confirmed",
      };
    }
    // Relay open and never confirmed closed: our ON is still outstanding.
    // Retry on a backoff instead of once a minute forever.
    if (!input.relayOn && mayRetry(state, input)) return issueCommand(state, input, "on", null);
    return { state, command: null, transition: null };
  }

  // ---- charging ----
  if (!input.gridConnected) {
    // Mains dropped while the breaker is still closed: pause the timer and
    // wait. No relay command — the relay is already where we want it.
    return {
      state: { ...state, phase: "waiting_for_grid", charge_start_ts: null, until_ts: null },
      command: null,
      transition: "grid_lost",
    };
  }

  return { state, command: null, transition: null };
}
