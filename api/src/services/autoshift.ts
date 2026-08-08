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
|--------------------------------------------------------------------------
*/

export type AutoshiftPhase = "idle" | "waiting_for_grid" | "charging" | "stopping";
export type AutoshiftStopReason = "disabled" | "window_ended" | "pv_recovered" | "duration_complete";

export interface AutoshiftConfig {
  enabled: boolean;
  threshold_v: number;
  duration_min: number;
  pv_stop_w: number;
}

export interface AutoshiftState {
  phase: AutoshiftPhase;
  trigger_ts: number | null;
  trigger_voltage: number | null;
  charge_start_ts: number | null;
  until_ts: number | null;
  stop_reason: AutoshiftStopReason | null;
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
  | "stopped";

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
};

export const EMPTY_AUTOSHIFT_STATE: AutoshiftState = {
  phase: "idle",
  trigger_ts: null,
  trigger_voltage: null,
  charge_start_ts: null,
  until_ts: null,
  stop_reason: null,
};

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
  const validReasons: AutoshiftStopReason[] = ["disabled", "window_ended", "pv_recovered", "duration_complete"];
  const stop_reason: AutoshiftStopReason | null = validReasons.includes(raw.stop_reason) ? raw.stop_reason : null;

  return {
    phase,
    trigger_ts: finiteOrNull(raw.trigger_ts),
    trigger_voltage: finiteOrNull(raw.trigger_voltage),
    charge_start_ts: finiteOrNull(raw.charge_start_ts),
    until_ts: finiteOrNull(raw.until_ts),
    stop_reason,
  };
}

function idleState(): AutoshiftState {
  return { ...EMPTY_AUTOSHIFT_STATE };
}

/** Why an active cycle should end, or null to keep going. */
function stopReason(
  cfg: AutoshiftConfig,
  input: AutoshiftInput,
  state: AutoshiftState
): AutoshiftStopReason | null {
  if (!cfg.enabled) return "disabled";
  if (state.phase === "waiting_for_grid" && !input.inNightWindow) return "window_ended";
  if (input.pvPower >= cfg.pv_stop_w) return "pv_recovered";
  if (state.phase === "charging" && input.nowTs >= (state.until_ts ?? 0)) return "duration_complete";
  return null;
}

export function planAutoshift(
  config: AutoshiftConfig,
  current: AutoshiftState | null,
  input: AutoshiftInput
): AutoshiftPlan {
  const state = normalizeAutoshiftState(current);

  // Stopping: keep asking for OFF until the breaker reads back open.
  if (state.phase === "stopping") {
    if (!input.relayOn) return { state: idleState(), command: null, transition: "stopped" };
    return { state, command: "off", transition: null };
  }

  if (state.phase === "idle") {
    if (config.enabled && input.inNightWindow && input.batteryVoltage <= config.threshold_v && !input.relayOn) {
      return {
        state: {
          phase: "waiting_for_grid",
          trigger_ts: input.nowTs,
          trigger_voltage: input.batteryVoltage,
          charge_start_ts: null,
          until_ts: null,
          stop_reason: null,
        },
        command: "on",
        transition: "started_waiting",
      };
    }
    return { state, command: null, transition: null };
  }

  const reason = stopReason(config, input, state);
  if (reason) {
    if (!input.relayOn) return { state: idleState(), command: null, transition: "stopped" };
    return {
      state: { ...state, phase: "stopping", until_ts: null, stop_reason: reason },
      command: "off",
      transition: "stop_requested",
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
    return { state, command: input.relayOn ? null : "on", transition: null };
  }

  // charging
  if (!input.gridConnected) {
    return {
      state: { ...state, phase: "waiting_for_grid", charge_start_ts: null, until_ts: null },
      command: input.relayOn ? null : "on",
      transition: "grid_lost",
    };
  }

  return { state, command: null, transition: null };
}
