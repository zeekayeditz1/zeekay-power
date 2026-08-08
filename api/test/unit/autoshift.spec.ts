import { describe, it, expect } from "vitest";
import {
  AUTOSHIFT_DEFAULT,
  AutoshiftConfig,
  AutoshiftState,
  isPakistanNightWindow,
  normalizeAutoshiftConfig,
  normalizeAutoshiftState,
  planAutoshift,
} from "../../src/services/autoshift";

/*
|--------------------------------------------------------------------------
| Auto-shift planner tests
|--------------------------------------------------------------------------
| These replay the exact incidents recorded in the Tuya breaker's operation
| log and the dashboard's own event feed, and assert on the number of PHYSICAL
| relay operations the planner asks for. The bar is not "does it eventually
| settle" — it is "how many times does the contactor move".
|--------------------------------------------------------------------------
*/

/** 2026-08-07 18:00 Pakistan time == 13:00 UTC. */
const PKT = (dayIso: string, hh: number, mm: number) =>
  Math.floor(Date.parse(`${dayIso}T00:00:00Z`) / 1000) + (hh - 5) * 3600 + mm * 60;

interface Tick {
  ts: number;
  v: number;
  pv: number;
  /** Is mains physically present on the WAPDA line this minute? */
  mains?: boolean;
  /** Something other than this controller moved the breaker before this tick. */
  externalRelay?: boolean;
  /** Simulate the Tuya command failing to confirm (breaker offline). */
  commandFails?: boolean;
}

interface SimResult {
  operations: { ts: number; command: "on" | "off" }[];
  transitions: { ts: number; transition: string }[];
  finalRelayOn: boolean;
  finalState: AutoshiftState;
}

/** Faithful stand-in for the auto-shift section of runSocTick, including the
 *  post-command re-plan against the confirmed read-back. */
function simulate(
  cfg: AutoshiftConfig,
  ticks: Tick[],
  opts: { relayOn?: boolean; state?: any } = {}
): SimResult {
  let relayOn = opts.relayOn ?? false;
  let state: any = opts.state ?? null;
  const operations: SimResult["operations"] = [];
  const transitions: SimResult["transitions"] = [];

  for (const t of ticks) {
    if (t.externalRelay !== undefined) relayOn = t.externalRelay;
    const mains = t.mains ?? true;

    const base = {
      nowTs: t.ts,
      batteryVoltage: t.v,
      pvPower: t.pv,
      inNightWindow: isPakistanNightWindow(t.ts),
    };

    const plan = planAutoshift(cfg, state, { ...base, relayOn, gridConnected: relayOn && mains });
    state = plan.state;
    if (plan.transition) transitions.push({ ts: t.ts, transition: plan.transition });

    if (plan.command) {
      operations.push({ ts: t.ts, command: plan.command });
      if (!t.commandFails) {
        relayOn = plan.command === "on";
        const confirmed = planAutoshift(cfg, state, { ...base, relayOn, gridConnected: relayOn && mains });
        state = confirmed.state;
        if (confirmed.transition) transitions.push({ ts: t.ts, transition: confirmed.transition });
      }
    }
  }

  return { operations, transitions, finalRelayOn: relayOn, finalState: state };
}

const CFG: AutoshiftConfig = normalizeAutoshiftConfig({
  ...AUTOSHIFT_DEFAULT,
  enabled: true,
  threshold_v: 48.8,
  duration_min: 360,
  pv_stop_w: 200,
});

/** One tick per minute over a span, with constant conditions. */
function minutes(startTs: number, count: number, fill: Omit<Tick, "ts">): Tick[] {
  return Array.from({ length: count }, (_, i) => ({ ts: startTs + i * 60, ...fill }));
}

describe("config + state normalisation", () => {
  it("defaults the new relay-protection knobs and clamps them", () => {
    expect(normalizeAutoshiftConfig({}).min_on_min).toBe(15);
    expect(normalizeAutoshiftConfig({}).cooldown_min).toBe(30);
    expect(normalizeAutoshiftConfig({ min_on_min: 999 }).min_on_min).toBe(15);
    expect(normalizeAutoshiftConfig({ cooldown_min: -5 }).cooldown_min).toBe(30);
    expect(normalizeAutoshiftConfig({ min_on_min: 0, cooldown_min: 0 })).toMatchObject({
      min_on_min: 0,
      cooldown_min: 0,
    });
  });

  it("treats a pre-upgrade charging state as already-confirmed-closed", () => {
    // Old states have no relay_closed_ts. Reading it as null would let the
    // controller re-close a breaker somebody else opened, exactly once, on the
    // first tick after deploy.
    const migrated = normalizeAutoshiftState({ phase: "charging", charge_start_ts: 1000, until_ts: 9000 });
    expect(migrated.relay_closed_ts).toBe(1000);
  });

  it("migrates the legacy {active:true} shape", () => {
    const migrated = normalizeAutoshiftState({ active: true, trigger_ts: 500, until_ts: 3000 });
    expect(migrated.phase).toBe("charging");
    expect(migrated.charge_start_ts).toBe(500);
  });
});

describe("regression: the 18:02 sunset oscillator (2026-08-07)", () => {
  /*
    Recorded that evening: battery sat right on the 48.8 V trigger while PV was
    still 200-355 W. The old planner armed, instantly tripped its own PV stop,
    and re-armed on the next tick — Tuya logged ON 18:02, OFF 18:02, ON 18:04,
    and the event feed shows five arm/stop pairs between 18:02 and 18:20.
  */
  const start = PKT("2026-08-07", 18, 0);

  it("does not arm while PV is still above the stop threshold", () => {
    const ticks: Tick[] = [
      ...minutes(start, 20, { v: 48.5, pv: 355 }),   // 18:00-18:19, PV above stop
      ...minutes(start + 20 * 60, 10, { v: 48.5, pv: 150 }), // 18:20 on, PV below
    ];
    const { operations } = simulate(CFG, ticks);

    // Exactly one operation, and it happens only once PV has genuinely fallen.
    expect(operations).toHaveLength(1);
    expect(operations[0].command).toBe("on");
    expect(operations[0].ts).toBe(start + 20 * 60);
  });

  it("PV hovering around the threshold cannot produce a burst of operations", () => {
    // Clouds: PV alternates 180/220 W either side of the 200 W stop, all evening.
    const ticks: Tick[] = Array.from({ length: 120 }, (_, i) => ({
      ts: start + i * 60,
      v: 48.4,
      pv: i % 2 === 0 ? 220 : 180,
    }));
    const { operations } = simulate(CFG, ticks);

    // Old behaviour: an ON/OFF pair every couple of minutes — ~60 operations
    // across this window. New behaviour is bounded by construction: a cycle
    // cannot be shorter than min_on_min, and the next one cannot start before
    // cooldown_min, so 120 minutes allows at most ceil(120/45) = 3 cycles.
    const maxCycles = Math.ceil(120 / (CFG.min_on_min + CFG.cooldown_min));
    expect(operations.length).toBeLessThanOrEqual(2 * maxCycles);

    // And no two operations may ever land in the same minute.
    const stamps = operations.map((o) => o.ts);
    expect(new Set(stamps).size).toBe(stamps.length);
  });
});

describe("regression: the daily 06:00 flap", () => {
  /*
    Every single day the log showed OFF 06:00, ON 06:00, OFF 06:01. The breaker
    opened on its own at 06:00; the old planner saw "grid lost" while charging
    and re-closed it, then the window-ended check opened it again a minute later.
  */
  it("ends the cycle with zero relay operations when the breaker is already open", () => {
    const startCharge = PKT("2026-08-08", 0, 30);
    const state: AutoshiftState = {
      ...normalizeAutoshiftState(null),
      phase: "charging",
      trigger_ts: startCharge,
      trigger_voltage: 48.4,
      charge_start_ts: startCharge,
      until_ts: startCharge + 360 * 60,
      relay_closed_ts: startCharge,
    };

    const sixAm = PKT("2026-08-08", 6, 0);
    const ticks: Tick[] = [
      { ts: sixAm - 60, v: 50.2, pv: 0 },                       // 05:59, still charging
      { ts: sixAm, v: 50.2, pv: 0, externalRelay: false },      // 06:00, breaker opened elsewhere
      ...minutes(sixAm + 60, 10, { v: 50.2, pv: 0 }),           // 06:01 onwards
    ];

    const { operations, transitions, finalRelayOn } = simulate(CFG, ticks, { relayOn: true, state });

    expect(operations).toHaveLength(0);
    expect(finalRelayOn).toBe(false);
    expect(transitions.map((t) => t.transition)).toContain("stopped");
  });

  it("opens the relay exactly once when it is still closed at 06:00", () => {
    const startCharge = PKT("2026-08-08", 3, 0);
    const state: AutoshiftState = {
      ...normalizeAutoshiftState(null),
      phase: "charging",
      charge_start_ts: startCharge,
      until_ts: startCharge + 360 * 60, // would otherwise run to 09:00
      relay_closed_ts: startCharge,
    };

    const sixAm = PKT("2026-08-08", 6, 0);
    const ticks = [
      { ts: sixAm - 60, v: 50.0, pv: 0 },
      ...minutes(sixAm, 30, { v: 50.0, pv: 0 }),
    ];

    const { operations, finalRelayOn } = simulate(CFG, ticks, { relayOn: true, state });

    expect(operations).toEqual([{ ts: sixAm, command: "off" }]);
    expect(finalRelayOn).toBe(false);
  });

  it("does not re-arm after 06:00 even with a flat battery", () => {
    const sixAm = PKT("2026-08-08", 6, 0);
    const ticks = minutes(sixAm, 120, { v: 46.0, pv: 0 }); // 06:00-08:00, battery low
    const { operations } = simulate(CFG, ticks);
    expect(operations).toHaveLength(0);
  });
});

describe("rule 3: never fight another controller", () => {
  it("ends the cycle instead of re-closing a breaker opened elsewhere", () => {
    const t0 = PKT("2026-08-08", 22, 0);
    const state: AutoshiftState = {
      ...normalizeAutoshiftState(null),
      phase: "charging",
      charge_start_ts: t0,
      until_ts: t0 + 360 * 60,
      relay_closed_ts: t0,
    };

    const ticks: Tick[] = [
      { ts: t0 + 3600, v: 49.5, pv: 0 },
      { ts: t0 + 3660, v: 49.5, pv: 0, externalRelay: false }, // 23:01 someone opens it
      ...minutes(t0 + 3720, 20, { v: 49.5, pv: 0 }),
    ];

    const { operations, transitions } = simulate(CFG, ticks, { relayOn: true, state });

    expect(operations).toHaveLength(0);
    expect(transitions.map((t) => t.transition)).toContain("external_override");
  });

  it("still retries its own ON that never landed, on a backoff", () => {
    const t0 = PKT("2026-08-08", 20, 0);
    // Breaker offline: every command is issued but never confirms.
    const ticks = minutes(t0, 60, { v: 48.0, pv: 0, commandFails: true, mains: false });
    const { operations } = simulate(CFG, ticks);

    // Old behaviour re-sent the command every single minute (58 in an hour on
    // 2026-08-08). Backoff: 0s, 60s, 180s, 420s, then every 600s.
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.length).toBeLessThanOrEqual(8);
    expect(operations.every((o) => o.command === "on")).toBe(true);

    const gaps = operations.slice(1).map((o, i) => o.ts - operations[i].ts);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(60);
  });
});

describe("rule 4: dwell and cooldown", () => {
  it("holds the relay closed for the minimum ON time when PV recovers early", () => {
    const t0 = PKT("2026-08-08", 5, 0); // inside the window
    const ticks: Tick[] = [
      { ts: t0, v: 48.0, pv: 0 },                         // arms + closes
      ...minutes(t0 + 60, 5, { v: 48.5, pv: 900 }),       // PV jumps past the stop after 1 min
      ...minutes(t0 + 360, 20, { v: 48.5, pv: 900 }),     // ... and stays there
    ];
    const { operations } = simulate(CFG, ticks);

    expect(operations[0]).toEqual({ ts: t0, command: "on" });
    const off = operations.find((o) => o.command === "off");
    expect(off).toBeDefined();
    // 15-minute minimum ON, not the ~1 minute the old planner allowed.
    expect(off!.ts - t0).toBeGreaterThanOrEqual(15 * 60);
  });

  it("caps the minimum ON at the configured hold duration", () => {
    const shortCfg = normalizeAutoshiftConfig({ ...CFG, duration_min: 5, min_on_min: 60 });
    const t0 = PKT("2026-08-08", 1, 0);
    const ticks: Tick[] = [
      { ts: t0, v: 48.0, pv: 0 },
      ...minutes(t0 + 60, 30, { v: 48.5, pv: 0 }),
    ];
    const { operations } = simulate(shortCfg, ticks);
    const off = operations.find((o) => o.command === "off");
    expect(off).toBeDefined();
    // duration_complete at +5 min must not be postponed to +60 min.
    expect(off!.ts - t0).toBeLessThanOrEqual(6 * 60);
  });

  it("refuses to start a new cycle during the cooldown", () => {
    const t0 = PKT("2026-08-07", 19, 0);
    const cfg = normalizeAutoshiftConfig({ ...CFG, duration_min: 5, min_on_min: 0, cooldown_min: 30 });
    const ticks: Tick[] = [
      { ts: t0, v: 48.0, pv: 0 },                    // arm + close
      ...minutes(t0 + 60, 40, { v: 48.0, pv: 0 }),   // runs 5 min, stops, then 35 min of low battery
    ];
    const { operations } = simulate(cfg, ticks);

    const off = operations.find((o) => o.command === "off")!;
    expect(off).toBeDefined();

    // Nothing at all between the OFF and the end of the cooldown window, even
    // though the battery stays under the trigger the whole time.
    const inCooldown = operations.filter((o) => o.ts > off.ts && o.ts < off.ts + cfg.cooldown_min * 60);
    expect(inCooldown).toHaveLength(0);

    // The next ON, if any, is on the far side of the cooldown.
    const nextOn = operations.find((o) => o.command === "on" && o.ts > off.ts);
    if (nextOn) expect(nextOn.ts - off.ts).toBeGreaterThanOrEqual(cfg.cooldown_min * 60);
  });

  it("does re-arm once the cooldown has expired and the battery is still low", () => {
    const t0 = PKT("2026-08-07", 18, 30);
    const cfg = normalizeAutoshiftConfig({ ...CFG, duration_min: 5, min_on_min: 0, cooldown_min: 30 });
    const ticks: Tick[] = [
      { ts: t0, v: 48.0, pv: 0 },
      ...minutes(t0 + 60, 120, { v: 48.0, pv: 0 }),
    ];
    const { operations } = simulate(cfg, ticks);
    expect(operations.filter((o) => o.command === "on").length).toBeGreaterThanOrEqual(2);
  });
});

describe("normal operation is unchanged", () => {
  it("closes, confirms grid, holds for the configured duration, then opens", () => {
    const t0 = PKT("2026-08-07", 21, 0);
    const cfg = normalizeAutoshiftConfig({ ...CFG, duration_min: 60 });
    const ticks: Tick[] = [
      { ts: t0, v: 48.0, pv: 0 },
      ...minutes(t0 + 60, 90, { v: 49.5, pv: 0 }),
    ];
    const { operations, transitions } = simulate(cfg, ticks);

    expect(operations).toHaveLength(2);
    expect(operations[0].command).toBe("on");
    expect(operations[1].command).toBe("off");
    expect(operations[1].ts - operations[0].ts).toBeGreaterThanOrEqual(60 * 60);
    expect(transitions.map((t) => t.transition)).toContain("grid_confirmed");
  });

  it("pauses the timer without touching the relay when mains drops mid-charge", () => {
    const t0 = PKT("2026-08-07", 20, 0);
    const cfg = normalizeAutoshiftConfig({ ...CFG, duration_min: 30 });
    const ticks: Tick[] = [
      { ts: t0, v: 48.0, pv: 0, mains: true },
      ...minutes(t0 + 60, 20, { v: 48.2, pv: 0, mains: false }), // load-shedding, breaker stays closed
      ...minutes(t0 + 1320, 40, { v: 49.0, pv: 0, mains: true }), // mains back
    ];
    const { operations, transitions } = simulate(cfg, ticks);

    expect(transitions.map((t) => t.transition)).toContain("grid_lost");
    // One ON at the start, one OFF at the end. Nothing in between.
    expect(operations.filter((o) => o.command === "on")).toHaveLength(1);
    expect(operations.filter((o) => o.command === "off")).toHaveLength(1);
  });

  it("never arms outside the 18:00-06:00 window", () => {
    const noon = PKT("2026-08-08", 12, 0);
    const { operations } = simulate(CFG, minutes(noon, 240, { v: 44.0, pv: 0 }));
    expect(operations).toHaveLength(0);
  });

  it("stops immediately when the feature is switched off mid-cycle", () => {
    const t0 = PKT("2026-08-08", 2, 0);
    const state: AutoshiftState = {
      ...normalizeAutoshiftState(null),
      phase: "charging",
      charge_start_ts: t0,
      until_ts: t0 + 360 * 60,
      relay_closed_ts: t0, // closed one second ago — min-ON must not delay this
    };
    const disabled = normalizeAutoshiftConfig({ ...CFG, enabled: false });
    const { operations } = simulate(disabled, [{ ts: t0 + 60, v: 49, pv: 0 }], { relayOn: true, state });
    expect(operations).toEqual([{ ts: t0 + 60, command: "off" }]);
  });
});

describe("whole-night replay: 2026-08-07 18:00 to 2026-08-08 08:00", () => {
  it("keeps physical relay operations in single digits", () => {
    const start = PKT("2026-08-07", 18, 0);
    const ticks: Tick[] = [];
    for (let i = 0; i < 14 * 60; i++) {
      const ts = start + i * 60;
      const hour = new Date((ts + 5 * 3600) * 1000).getUTCHours();
      // Sunset PV decay, flat overnight, sunrise ramp.
      const pv = hour >= 18 && hour < 19 ? Math.max(0, 400 - i * 8) : hour >= 6 ? (hour - 6) * 400 : 0;
      // Battery sags overnight, right around the trigger.
      const v = 48.9 - Math.min(1.2, i * 0.0012);
      // Two load-shedding outages, matching the recorded 23:31 and 06:00 events.
      const outage = (i > 330 && i < 390) || (i > 720 && i < 735);
      ticks.push({ ts, v, pv, mains: !outage, externalRelay: i === 331 || i === 721 ? false : undefined });
    }

    const { operations } = simulate(CFG, ticks);
    expect(operations.length).toBeLessThanOrEqual(8);
  });
});
