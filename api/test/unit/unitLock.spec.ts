import { describe, expect, it } from "vitest";
import {
  EMPTY_UNIT_LOCK_STATE,
  UNIT_LOCK_LIMIT_KWH,
  isUnitLockEnforced,
  normalizeUnitLockConfig,
  planUnitLock,
  reconcileUnitLockAutoshift,
  unitLockWarningKwh,
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
    let plan = planUnitLock(null, { nowTs: t0, energyTotalKwh: 100 });
    expect(plan.state.used_kwh).toBe(0);

    plan = planUnitLock(plan.state, { nowTs: t0 + 4 * 3600, energyTotalKwh: 105 });
    expect(plan.warning_reached).toBe(true);
    expect(plan.just_locked).toBe(false);
    expect(plan.state.used_kwh).toBeCloseTo(5, 6);

    plan = planUnitLock(plan.state, { nowTs: t0 + 5 * 3600, energyTotalKwh: 106 });
    expect(plan.just_locked).toBe(true);
    expect(plan.enforce_off).toBe(true);
    expect(plan.state.used_kwh).toBeCloseTo(UNIT_LOCK_LIMIT_KWH, 6);
  });

  it("does not estimate units while the cumulative Tuya meter is absent", () => {
    const t0 = PKT("2026-08-11", 17, 0);
    let plan = planUnitLock(null, { nowTs: t0, energyTotalKwh: null });
    plan = planUnitLock(plan.state, { nowTs: t0 + 6 * 3600, energyTotalKwh: null });
    expect(plan.state.used_kwh).toBe(0);
    expect(plan.enforce_off).toBe(false);
  });

  it("migrates a false v2 integrated-power lock back to the Tuya meter delta", () => {
    const t0 = PKT("2026-08-11", 17, 0);
    const oldState = {
      ...EMPTY_UNIT_LOCK_STATE,
      version: 2,
      window_start_ts: t0,
      window_end_ts: t0 + 13 * 3600,
      unlock_ts: t0 + 15 * 3600,
      meter_start_kwh: 175.58,
      meter_last_kwh: 180.06,
      meter_delta_kwh: 4.5,
      integrated_kwh: 6.02,
      used_kwh: 6.02,
      locked: true,
      restore_autoshift_on_unlock: true,
    } as any;
    const plan = planUnitLock(oldState, { nowTs: t0 + 10 * 3600, energyTotalKwh: 180.06 });
    const restored = reconcileUnitLockAutoshift(plan.state, plan, false);
    expect(plan.state.used_kwh).toBe(4.5);
    expect(plan.enforce_off).toBe(false);
    expect(plan.just_unlocked).toBe(true);
    expect(restored.enabled).toBe(true);
  });

  it("never loses already-counted usage if the Tuya cumulative counter resets", () => {
    const t0 = PKT("2026-08-11", 17, 0);
    let state = planUnitLock(null, { nowTs: t0, energyTotalKwh: 100 }).state;
    state = planUnitLock(state, { nowTs: t0 + 3600, energyTotalKwh: 104 }).state;
    state = planUnitLock(state, { nowTs: t0 + 7200, energyTotalKwh: 2 }).state;
    const plan = planUnitLock(state, { nowTs: t0 + 10_800, energyTotalKwh: 3.5 });
    expect(plan.state.used_kwh).toBeCloseTo(5.5, 6);
    expect(plan.state.warning_sent).toBe(true);
  });
});

describe("lock enforcement and reset", () => {
  it("turns auto-shift OFF at the limit and restores it exactly at 08:00", () => {
    const t0 = PKT("2026-08-11", 17, 0);
    let lockPlan = planUnitLock(null, { nowTs: t0, energyTotalKwh: 100 });
    lockPlan = planUnitLock(lockPlan.state, {
      nowTs: PKT("2026-08-12", 1, 0),
      energyTotalKwh: 106,
    });

    const disabled = reconcileUnitLockAutoshift(lockPlan.state, lockPlan, true);
    expect(lockPlan.just_locked).toBe(true);
    expect(lockPlan.enforce_off).toBe(true);
    expect(disabled.enabled).toBe(false);
    expect(disabled.disabled_by_lock).toBe(true);
    expect(disabled.state.restore_autoshift_on_unlock).toBe(true);

    const releasePlan = planUnitLock(disabled.state, {
      nowTs: PKT("2026-08-12", 8, 0),
      energyTotalKwh: 106,
    });
    const restored = reconcileUnitLockAutoshift(releasePlan.state, releasePlan, disabled.enabled);
    expect(releasePlan.just_unlocked).toBe(true);
    expect(releasePlan.enforce_off).toBe(false);
    expect(restored.enabled).toBe(true);
    expect(restored.restored_at_release).toBe(true);
    expect(restored.state.restore_autoshift_on_unlock).toBe(false);
  });

  it("uses an editable limit immediately without releasing an existing lock early", () => {
    expect(normalizeUnitLockConfig({ limit_kwh: 4.5 }).limit_kwh).toBe(4.5);
    expect(unitLockWarningKwh(4.5)).toBe(3.6);

    const t0 = PKT("2026-08-11", 17, 0);
    let plan = planUnitLock(null, { nowTs: t0, energyTotalKwh: 10 }, { limit_kwh: 4.5 });
    plan = planUnitLock(plan.state, {
      nowTs: t0 + 3600,
      energyTotalKwh: 14.5,
    }, { limit_kwh: 4.5 });
    expect(plan.just_locked).toBe(true);
    expect(plan.state.limit_kwh).toBe(4.5);

    plan = planUnitLock(plan.state, {
      nowTs: t0 + 7200,
      energyTotalKwh: 14.5,
    }, { limit_kwh: 10 });
    expect(plan.enforce_off).toBe(true);
    expect(plan.state.limit_kwh).toBe(10);
  });

  it("turns enforcement off immediately and starts a fresh Tuya baseline when re-enabled", () => {
    const t0 = PKT("2026-08-11", 17, 0);
    let plan = planUnitLock(null, { nowTs: t0, energyTotalKwh: 100 });
    plan = planUnitLock(plan.state, { nowTs: t0 + 3600, energyTotalKwh: 106 });
    const disabledAuto = reconcileUnitLockAutoshift(plan.state, plan, true);

    const offPlan = planUnitLock(disabledAuto.state, {
      nowTs: t0 + 3660,
      energyTotalKwh: 106,
    }, { enabled: false, limit_kwh: 6 });
    const restoredAuto = reconcileUnitLockAutoshift(offPlan.state, offPlan, disabledAuto.enabled);
    expect(offPlan.phase).toBe("disabled");
    expect(offPlan.enforce_off).toBe(false);
    expect(offPlan.state.used_kwh).toBe(0);
    expect(restoredAuto.enabled).toBe(true);

    let reenabled = planUnitLock(restoredAuto.state, {
      nowTs: t0 + 7200,
      energyTotalKwh: 107,
    }, { enabled: true, limit_kwh: 6 });
    expect(reenabled.state.used_kwh).toBe(0);
    reenabled = planUnitLock(reenabled.state, {
      nowTs: t0 + 10_800,
      energyTotalKwh: 108,
    }, { enabled: true, limit_kwh: 6 });
    expect(reenabled.state.used_kwh).toBe(1);
  });

  it("keeps WAPDA locked after 06:00 and unlocks at 08:00", () => {
    const t0 = PKT("2026-08-11", 17, 0);
    let plan = planUnitLock(null, { nowTs: t0, energyTotalKwh: 50 });
    plan = planUnitLock(plan.state, { nowTs: t0 + 3600, energyTotalKwh: 56 });
    expect(plan.state.locked).toBe(true);

    plan = planUnitLock(plan.state, {
      nowTs: PKT("2026-08-12", 6, 1),
      energyTotalKwh: 56,
    });
    expect(plan.phase).toBe("release_hold");
    expect(plan.enforce_off).toBe(true);
    expect(isUnitLockEnforced(plan.state, PKT("2026-08-12", 7, 59))).toBe(true);

    plan = planUnitLock(plan.state, {
      nowTs: PKT("2026-08-12", 8, 0),
      energyTotalKwh: 56,
    });
    expect(plan.just_unlocked).toBe(true);
    expect(plan.enforce_off).toBe(false);
  });

  it("does not touch automation when the finished window stays below 6 kWh", () => {
    const t0 = PKT("2026-08-11", 17, 0);
    let plan = planUnitLock(null, { nowTs: t0, energyTotalKwh: 20 });
    plan = planUnitLock(plan.state, {
      nowTs: PKT("2026-08-12", 6, 1),
      energyTotalKwh: 25.9,
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
    });
    expect(plan.just_started).toBe(true);
    expect(plan.state.used_kwh).toBe(0);
    expect(plan.state.warning_sent).toBe(false);
    expect(plan.state.meter_start_kwh).toBe(80);
  });
});
