import { describe, expect, it } from "vitest";
import {
  EMPTY_UNIT_LOCK_STATE,
  UNIT_LOCK_LIMIT_KWH,
  isUnitLockEnforced,
  planUnitLock,
  unitLockWindow,
} from "../../src/services/unitLock";

const PKT = (dayIso: string, hh: number, mm = 0) =>
  Math.floor(Date.parse(`${dayIso}T00:00:00Z`) / 1000) + (hh - 5) * 3600 + mm * 60;

describe("Pakistan-time Units Lock window", () => {
  it("tracks from 17:00 through 05:59 and releases a reached lock at 08:00", () => {
    expect(unitLockWindow(PKT("2026-08-11", 16, 59)).active).toBe(false);
    expect(unitLockWindow(PKT("2026-08-11", 17, 0)).active).toBe(true);
    expect(unitLockWindow(PKT("2026-08-12", 5, 59)).active).toBe(true);
    expect(unitLockWindow(PKT("2026-08-12", 6, 0)).active).toBe(false);

    const evening = unitLockWindow(PKT("2026-08-11", 20, 0));
    expect(evening.start).toBe(PKT("2026-08-11", 17, 0));
    expect(evening.end).toBe(PKT("2026-08-12", 6, 0));
    expect(evening.unlock).toBe(PKT("2026-08-12", 8, 0));
  });
});

describe("Tuya energy accounting", () => {
  it("warns at 5 kWh and hard-locks at exactly 6 kWh", () => {
    const t0 = PKT("2026-08-11", 17, 0);
    let plan = planUnitLock(null, { nowTs: t0, energyTotalKwh: 100, powerW: 0 });
    expect(plan.state.used_kwh).toBe(0);

    plan = planUnitLock(plan.state, { nowTs: t0 + 4 * 3600, energyTotalKwh: 105, powerW: 0 });
    expect(plan.warning_reached).toBe(true);
    expect(plan.just_locked).toBe(false);
    expect(plan.state.used_kwh).toBeCloseTo(5, 6);

    plan = planUnitLock(plan.state, { nowTs: t0 + 5 * 3600, energyTotalKwh: 106, powerW: 0 });
    expect(plan.just_locked).toBe(true);
    expect(plan.enforce_off).toBe(true);
    expect(plan.state.used_kwh).toBeCloseTo(UNIT_LOCK_LIMIT_KWH, 6);
  });

  it("integrates Tuya active power when the cumulative meter is absent", () => {
    const t0 = PKT("2026-08-11", 17, 0);
    let state = planUnitLock(null, { nowTs: t0, energyTotalKwh: null, powerW: 1000 }).state;
    let lastPlan = planUnitLock(state, { nowTs: t0, energyTotalKwh: null, powerW: 1000 });
    for (let minute = 1; minute <= 360; minute++) {
      lastPlan = planUnitLock(state, {
        nowTs: t0 + minute * 60,
        energyTotalKwh: null,
        powerW: 1000,
      });
      state = lastPlan.state;
    }
    expect(state.integrated_kwh).toBeCloseTo(6, 6);
    expect(lastPlan.enforce_off).toBe(true);
  });

  it("falls back to Tuya volts multiplied by amps when active power is missing", () => {
    const t0 = PKT("2026-08-11", 17, 0);
    let plan = planUnitLock(null, {
      nowTs: t0,
      energyTotalKwh: null,
      powerW: null,
      voltageV: 200,
      currentA: 5,
    });
    plan = planUnitLock(plan.state, {
      nowTs: t0 + 60,
      energyTotalKwh: null,
      powerW: null,
      voltageV: 200,
      currentA: 5,
    });
    expect(plan.state.integrated_kwh).toBeCloseTo(1 / 60, 6);
  });

  it("never loses already-counted usage if the Tuya cumulative counter resets", () => {
    const t0 = PKT("2026-08-11", 17, 0);
    let state = planUnitLock(null, { nowTs: t0, energyTotalKwh: 100, powerW: 0 }).state;
    state = planUnitLock(state, { nowTs: t0 + 3600, energyTotalKwh: 104, powerW: 0 }).state;
    state = planUnitLock(state, { nowTs: t0 + 7200, energyTotalKwh: 2, powerW: 0 }).state;
    const plan = planUnitLock(state, { nowTs: t0 + 10_800, energyTotalKwh: 3.5, powerW: 0 });
    expect(plan.state.used_kwh).toBeCloseTo(5.5, 6);
    expect(plan.state.warning_sent).toBe(true);
  });
});

describe("lock enforcement and reset", () => {
  it("keeps WAPDA locked after 06:00 and unlocks at 08:00", () => {
    const t0 = PKT("2026-08-11", 17, 0);
    let plan = planUnitLock(null, { nowTs: t0, energyTotalKwh: 50, powerW: 0 });
    plan = planUnitLock(plan.state, { nowTs: t0 + 3600, energyTotalKwh: 56, powerW: 0 });
    expect(plan.state.locked).toBe(true);

    plan = planUnitLock(plan.state, {
      nowTs: PKT("2026-08-12", 6, 1),
      energyTotalKwh: 56,
      powerW: 0,
    });
    expect(plan.phase).toBe("release_hold");
    expect(plan.enforce_off).toBe(true);
    expect(isUnitLockEnforced(plan.state, PKT("2026-08-12", 7, 59))).toBe(true);

    plan = planUnitLock(plan.state, {
      nowTs: PKT("2026-08-12", 8, 0),
      energyTotalKwh: 56,
      powerW: 0,
    });
    expect(plan.just_unlocked).toBe(true);
    expect(plan.enforce_off).toBe(false);
  });

  it("does not touch automation when the finished window stays below 6 kWh", () => {
    const t0 = PKT("2026-08-11", 17, 0);
    let plan = planUnitLock(null, { nowTs: t0, energyTotalKwh: 20, powerW: 0 });
    plan = planUnitLock(plan.state, {
      nowTs: PKT("2026-08-12", 6, 1),
      energyTotalKwh: 25.9,
      powerW: 0,
    });
    expect(plan.state.used_kwh).toBeCloseTo(5.9, 6);
    expect(plan.state.locked).toBe(false);
    expect(plan.enforce_off).toBe(false);
    expect(plan.state.restore_autoshift_on_unlock).toBe(false);
  });

  it("starts a clean counter at the next 17:00 window", () => {
    const previous = {
      ...EMPTY_UNIT_LOCK_STATE,
      window_start_ts: PKT("2026-08-10", 17, 0),
      window_end_ts: PKT("2026-08-11", 6, 0),
      unlock_ts: PKT("2026-08-11", 8, 0),
      meter_start_kwh: 70,
      meter_last_kwh: 75.5,
      meter_delta_kwh: 5.5,
      used_kwh: 5.5,
      warning_sent: true,
    };
    const plan = planUnitLock(previous, {
      nowTs: PKT("2026-08-11", 17, 0),
      energyTotalKwh: 80,
      powerW: 500,
    });
    expect(plan.just_started).toBe(true);
    expect(plan.state.used_kwh).toBe(0);
    expect(plan.state.warning_sent).toBe(false);
    expect(plan.state.meter_start_kwh).toBe(80);
  });
});
