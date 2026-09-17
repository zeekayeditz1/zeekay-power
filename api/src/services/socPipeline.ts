import { runAutomationTick } from "./automation";
import { BATTERY_MAX_SAMPLE_GAP_S } from "./telemetry";
import { processControllerCommands } from "./controllerCommands";
import { recordDischargeSample, recordWapdaSample, dischargeDays } from "./energyStore";
/*
| SOC + energy pipeline: pull SEMS, run estimator, read Tuya breaker, persist a
| rich live_status for /api/status, log a daily energy row (real inverter
| counters — grid import, charge, discharge) for billing-cycle history, and
| run the voltage-triggered auto-shift-to-WAPDA automation.
| Runs every minute (cron) and on-demand via /api/poll.
*/
import { fetchSemsSnapshot } from "./sems";
import { step, SocState } from "./soc";
import { fetchTuyaStatus, tuyaConfigured, TuyaStatus } from "./tuya";
import {
  getState,
  setState,
  ensureTables,
  logEvent,
  acquireTickLock,
  releaseTickLock,
} from "./dashboardStore";
import { GridSignals, isGridConnected, isMainsAvailable } from "./autoshift";
import { isUnitLockEnforced, unitLockWarningKwh } from "./unitLock";

const r2 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 100) / 100);
// Pakistan is UTC+5 (no DST) — local calendar day for "today" counters & the billing-cycle grouping.
function localDay(ts_s: number) { return new Date((ts_s + 5 * 3600) * 1000).toISOString().slice(0, 10); }

export async function runSocTick(env: any) {
  await ensureTables(env);

  // Manual controls run independently of SEMS, even when its API is down.
  await processControllerCommands(env);
  // Slow inverter polling does not occupy the hardware-control lock.
  const snap = await fetchSemsSnapshot(env);
  if (snap.v == null || snap.p_chg == null || !Number.isFinite(snap.v) ||
      !Number.isFinite(snap.p_chg) || snap.v < 35 || snap.v > 65) {
    throw new Error("SEMS returned an invalid battery sample");
  }
  const nowEpoch = Math.floor(Date.now() / 1000);
  const lockExpiresAt = await acquireTickLock(env, nowEpoch, 180);
  if (lockExpiresAt == null) throw new Error("SOC tick already running");
  try {
    // --- SOC estimator ---
    let prev: SocState = {};
    try { const raw = await getState(env, "soc_state", ""); if (raw) prev = JSON.parse(raw); } catch {}
    const out = step(prev, { v: snap.v, p_chg: snap.p_chg, ts: snap.ts, bms_soc: snap.bms_soc });
    out.bms_soc = snap.bms_soc;
    await setState(env, "soc_state", JSON.stringify(out));

    // --- history row (voltage, battery power, soc) ---
    if(prev.last_ts==null || snap.ts>prev.last_ts) await env.zeekay_power_db.prepare(
      `INSERT OR REPLACE INTO battery_history (ts,v,p,soc_blended,soc_v,soc_cc,bms_soc,anchored)
     VALUES (?,?,?,?,?,?,?,?)`
    ).bind(snap.ts, snap.v, snap.p_chg, r2(out.usable_soc), r2(out.soc_v), r2(out.soc_cc), snap.bms_soc, out.anchored ? 1 : 0).run();
    await recordDischargeSample(env,{ts:snap.ts,p:snap.p_chg});
    const dischargeToday=(await dischargeDays(env,snap.ts,0))[0];

    // --- Tuya breaker (best-effort) ---
    let tuya: TuyaStatus | null = null;
    let previousTuya: any = null;
    let tuyaReadFailed = false;
    try {
      if (tuyaConfigured(env)) {
        try { const raw = await getState(env, "tuya_status", ""); if (raw) previousTuya = JSON.parse(raw); } catch {}
        tuya = await fetchTuyaStatus(env);
        await recordWapdaSample(env,tuya,Math.floor(Date.now()/1000));

        // The breaker can also be switched from the Tuya app, by a schedule on
        // the device, or by mains cycling. Surface those so a state change that
        // this controller did not cause is never silently invisible.
        if (tuya.online && previousTuya?.online && typeof previousTuya.relay_on === "boolean" && previousTuya.relay_on !== tuya.relay_on) {
          let expectedOwnCommand = false;
          try {
            const raw = await getState(env, "relay_command_pending", "");
            if (raw) {
              const pending = JSON.parse(raw);
              expectedOwnCommand = pending?.target === tuya.relay_on && Number(pending?.expires_at) >= snap.ts;
            }
          } catch {}
          if (!expectedOwnCommand) {
            await logEvent(
              env,
              "relay",
              tuya.relay_on ? "WAPDA relay closed (ON)" : "WAPDA relay opened (OFF)",
              "Physical state changed outside this dashboard between Cloudflare polls; cloud safety and automation rules are being applied to the new state"
            );
          }
          await setState(env, "relay_command_pending", "");
        }

        await setState(env, "tuya_status", JSON.stringify(tuya));
        await setState(env, "relay_state", tuya.relay_on ? "1" : "0");
        await setState(env, "relay_last_known", tuya.relay_on ? "1" : "0");
      }
    } catch (e: any) { tuyaReadFailed = true; console.error("tuya read:", e?.message); }

    // Log only on a REACHABILITY TRANSITION (not every tick) so a prolonged
    // outage doesn't spam the events feed, but the moment it goes down or comes
    // back is always visible on the dashboard.
    if (tuyaConfigured(env)) {
      let wasReachable = true;
      try { wasReachable = (await getState(env, "tuya_reachable", "1")) !== "0"; } catch {}
      const nowReachable = !tuyaReadFailed;
      if (wasReachable && !nowReachable) {
        await logEvent(env, "breaker", "WAPDA breaker unreachable",
          "Tuya cloud API call failed — auto-shift automation is paused until it reconnects");
      } else if (!wasReachable && nowReachable) {
        await logEvent(env, "breaker", "WAPDA breaker reconnected",
          "Tuya cloud API is responding again — auto-shift automation resumed");
      }
      try { await setState(env, "tuya_reachable", nowReachable ? "1" : "0"); } catch {}
    }

    let gridSignals: GridSignals = {
      relayOn: !!tuya?.relay_on,
      tuyaOnline: tuya?.online ?? null,
      // WAPDA decisions use only live mains-side telemetry.
      tuyaGridPower: tuya?.grid_power ?? null,
      tuyaGridVoltage: tuya?.grid_voltage ?? null,
    };
    let mainsAvailable = isMainsAvailable(gridSignals);
    let gridConnected = isGridConnected(gridSignals);

    // --- daily accumulator: PV peak (not provided by SEMS) + solar/WAPDA charge SPLIT RATIO ---
    // (magnitudes for charge/discharge now come straight from the inverter's own
    // day counters below — real meter readings, not our own integration — this
    // accumulator only tracks the proportion of charging that was solar-fed.)
    const today = localDay(snap.ts);
    let acc: any = {};
    try { const raw = await getState(env, "daily_energy", ""); if (raw) acc = JSON.parse(raw); } catch {}
    if (acc.date !== today) acc = { date: today, pv_peak_w: 0, charge_solar_wh: 0, charge_wapda_wh: 0, last_ts: snap.ts };
    const dt_h = acc.last_ts ? (snap.ts - acc.last_ts <= BATTERY_MAX_SAMPLE_GAP_S ? Math.max(0, snap.ts - acc.last_ts) : 0) / 3600 : 0;
    acc.pv_peak_w = Math.max(acc.pv_peak_w || 0, snap.solar_power || 0);
    const bp = snap.p_chg || 0; // +charge / -discharge (W)
    const wapdaOn = gridConnected;
    if (bp > 20 && dt_h > 0) {
      const wh = bp * dt_h;
      if(tuya?.online && snap.solar_power!=null && snap.load_power!=null) {
        const ratio=wapdaOn?Math.max(0,Math.min(1,(snap.solar_power-snap.load_power)/bp)):1;
        acc.charge_solar_wh+=wh*ratio; acc.charge_wapda_wh+=wh*(1-ratio);
      }
    }
    acc.last_ts = Math.max(acc.last_ts??0,snap.ts);
    await setState(env, "daily_energy", JSON.stringify(acc));

    // Real total charge/discharge today, straight from the inverter's own counters.
    const realChargeKwh = snap.charge_day_kwh;
    const realDischargeKwh = snap.discharge_day_kwh;
    const splitTotal = (acc.charge_solar_wh || 0) + (acc.charge_wapda_wh || 0);
    const solarRatio = splitTotal > 0 ? (acc.charge_solar_wh || 0) / splitTotal : 1;
    const chargeFromSolarKwh = realChargeKwh == null || splitTotal===0 ? null : realChargeKwh * solarRatio;
    const chargeFromWapdaKwh = realChargeKwh == null || splitTotal===0 ? null : realChargeKwh * (1 - solarRatio);

    // --- persist today's real counters for billing-cycle / monthly history ---
    await env.zeekay_power_db.prepare(
      `INSERT INTO daily_energy_log (date, wapda_import_kwh, solar_kwh, charge_kwh, discharge_kwh, pv_peak_w)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(date) DO UPDATE SET
      solar_kwh=MAX(COALESCE(daily_energy_log.solar_kwh,0),COALESCE(excluded.solar_kwh,daily_energy_log.solar_kwh)),
       charge_kwh=MAX(COALESCE(daily_energy_log.charge_kwh,0),COALESCE(excluded.charge_kwh,daily_energy_log.charge_kwh)), discharge_kwh=MAX(COALESCE(daily_energy_log.discharge_kwh,0),COALESCE(excluded.discharge_kwh,daily_energy_log.discharge_kwh)),
       pv_peak_w=MAX(daily_energy_log.pv_peak_w, excluded.pv_peak_w)`
    ).bind(today, 0, r2(snap.energy_today), r2(realChargeKwh), r2(realDischargeKwh), Math.round(acc.pv_peak_w || 0)).run();

    // --- once-a-day housekeeping so the free-tier D1 never fills up ---
    const lastMaintenanceDay = await getState(env, "last_maintenance_day", "");
    if (lastMaintenanceDay !== today) {
      const historyCutoff = snap.ts - 90 * 24 * 3600;
      await env.zeekay_power_db.batch([
        env.zeekay_power_db.prepare(`DELETE FROM battery_history WHERE ts < ?`).bind(historyCutoff),
        env.zeekay_power_db.prepare(`DELETE FROM wapda_meter_samples WHERE ts < ?`).bind(snap.ts-365*24*3600),
        env.zeekay_power_db.prepare(
          `DELETE FROM app_events
         WHERE id < COALESCE(
           (SELECT id FROM app_events ORDER BY id DESC LIMIT 1 OFFSET 4999),
           0
         )`
        ),
        env.zeekay_power_db.prepare(`DELETE FROM auth_rate_limits WHERE window_start < ?`).bind(snap.ts - 24 * 3600),
      ]);
      await setState(env, "last_maintenance_day", today);
    }

    const controls=await runAutomationTick(env,tuya,Math.floor(Date.now()/1000),snap);
    tuya=controls.tuya;
    const {cfg,asState,unitConfig,unitState,unitPlan}=controls;
    const unitWarningKwh=unitLockWarningKwh(unitConfig.limit_kwh);
    mainsAvailable=controls.mainsAvailable;
    gridConnected=controls.gridConnected;
    const charging = bp > 20;
    const wapdaPowerW = tuya?.grid_power ?? null;
    const tuyaOnlySignals: GridSignals = {
      relayOn: !!tuya?.relay_on,
      tuyaOnline: tuya?.online ?? null,
      tuyaGridPower: tuya?.grid_power ?? null,
      tuyaGridVoltage: tuya?.grid_voltage ?? null,
    };
    const wapdaAvailable = tuya ? isMainsAvailable(tuyaOnlySignals) : false;
    const wapdaActive = tuya ? isGridConnected(tuyaOnlySignals) : false;
    const unitLockEnforced = isUnitLockEnforced(unitState, nowEpoch, unitConfig.enabled);
    const status = {
      // battery
      battery_soc: Math.round(out.usable_soc ?? 0),
      battery_soc_precise: r2(out.usable_soc),
      battery_soc_basis: "usable_reserve_to_45v_cutoff",
      battery_chemical_soc: r2(out.blended),
      bms_soc: snap.bms_soc,
      soc_voltage: r2(out.soc_v),
      soc_coulomb: r2(out.soc_cc),
      battery_voltage: snap.v,
      battery_current: snap.battery_current,
      battery_power: r2(snap.p_chg),
      battery_charging: charging,
      usable_capacity_ah: r2(out.c_usable_ah),
      battery_usable_soc: r2(out.usable_soc),
      battery_runtime_min: r2(out.runtime_min),
      battery_runtime_confidence: out.runtime_confidence,
      battery_runtime_basis: "measured_overnight_curve_and_battery_draw",
      battery_cutoff_voltage: 45,
      battery_knee_warning: snap.p_chg < -20 && snap.v <= 46.5,
      // solar
      solar_power: Math.round(snap.solar_power || 0),
      solar_peak_today: Math.round(acc.pv_peak_w || 0),
      pv_today_kwh: r2(snap.energy_today),
      // load / measurements (FIXED: real load V/I, not grid vac1)
      load_power: Math.round(snap.load_power || 0),
      load_voltage: r2(snap.load_voltage ?? snap.output_voltage),
      load_current: r2(snap.load_current),
      // Explicitly separate inverter output/load telemetry from WAPDA. The
      // WAPDA fields below are Tuya-only and never fall back to SEMS.
      inverter_power: Math.round(snap.load_power || 0),
      inverter_voltage: r2(snap.output_voltage ?? snap.load_voltage),
      inverter_current: r2(snap.load_current),
      wapda_available: wapdaAvailable,
      wapda_active: wapdaActive,
      wapda_power: r2(wapdaPowerW),
      wapda_voltage: r2(tuya?.grid_voltage),
      wapda_current: r2(tuya?.grid_current),
      wapda_source: "tuya",
      // Legacy grid aliases retained for API compatibility.
      grid_power: Math.round(snap.grid_power || 0),
      grid_voltage: r2(tuya?.grid_voltage),
      mains_available: mainsAvailable,
      grid_connected: gridConnected,
      frequency: r2((tuya && tuya.frequency_hz) || snap.frequency),
      inverter_grid_today_kwh: r2(snap.wapda_today_kwh),
      meter_total_kwh: r2(tuya?.energy_total_kwh),
      // Kept for API compatibility, but explicitly represents inverter output
      // voltage. It must never be used as proof that WAPDA is present.
      ac_voltage: r2(snap.output_voltage),
      // energy today (real counters; solar/WAPDA split estimated by ratio)
      charge_from_solar_kwh: r2(chargeFromSolarKwh),
      charge_from_wapda_kwh: r2(chargeFromWapdaKwh),
      total_charge_kwh: r2(realChargeKwh),
      discharge_today_kwh: dischargeToday.discharge_kwh,
      discharge_calendar_day_kwh: r2(realDischargeKwh),
      discharge_window_start: dischargeToday.window_start,
      discharge_window_end: dischargeToday.window_end,
      discharge_coverage_pct: dischargeToday.coverage_pct,
      discharge_partial: dischargeToday.partial,
      discharge_source: "battery_dc_discharge_only",
      // breaker
      breaker_online: tuya ? tuya.online : null,
      breaker_energy_kwh: tuya ? tuya.energy_total_kwh : null,
      // Tuya cumulative-meter Units Lock: 17:00-06:00, enforced until 08:00.
      unit_lock_enabled: unitConfig.enabled,
      unit_lock_limit_kwh: unitConfig.limit_kwh,
      unit_lock_warning_kwh: unitWarningKwh,
      unit_lock_used_kwh: r2(unitState.used_kwh),
      unit_lock_remaining_kwh: r2(Math.max(0, unitConfig.limit_kwh - unitState.used_kwh)),
      unit_lock_locked: unitLockEnforced,
      unit_lock_phase: unitLockEnforced
        ? (snap.ts < (unitState.window_end_ts ?? 0) ? "locked" : "release_hold")
        : unitPlan.phase,
      unit_lock_window_start: unitState.window_start_ts ? new Date(unitState.window_start_ts * 1000).toISOString() : null,
      unit_lock_window_end: unitState.window_end_ts ? new Date(unitState.window_end_ts * 1000).toISOString() : null,
      unit_lock_unlock_at: unitState.unlock_ts ? new Date(unitState.unlock_ts * 1000).toISOString() : null,
      unit_lock_tracking_since: unitState.initialized_at_ts ? new Date(unitState.initialized_at_ts * 1000).toISOString() : null,
      unit_lock_restore_autoshift: unitState.restore_autoshift_on_unlock,
      unit_lock_source: "tuya_forward_energy_total_only",
      // autoshift status (for the settings card)
      autoshift_phase: asState.phase,
      autoshift_active: asState.phase !== "idle",
      autoshift_charging: asState.phase === "charging" && charging && gridConnected,
      autoshift_until: asState.until_ts ? new Date(asState.until_ts * 1000).toISOString() : null,
      autoshift_trigger_voltage: asState.trigger_voltage ?? null,
      autoshift_stop_reason: asState.stop_reason ?? null,
      // Relay-protection visibility: when the breaker may next be switched.
      autoshift_min_on_until: asState.relay_closed_ts
        ? new Date((asState.relay_closed_ts + Math.min(cfg.min_on_min, cfg.duration_min) * 60) * 1000).toISOString()
        : null,
      autoshift_cooldown_until: asState.last_end_ts
        ? new Date((asState.last_end_ts + cfg.cooldown_min * 60) * 1000).toISOString()
        : null,
      controller: "cloudflare-primary",
      sample_ts: snap.ts,
      sample_at: new Date(snap.ts * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    };
    await setState(env, "live_status", JSON.stringify(status));
    return status;
  } finally {
    try {
      await releaseTickLock(env, lockExpiresAt);
      await processControllerCommands(env);
    } catch (error: any) {
      console.error("failed to release SOC tick lock:", error?.message);
    }
  }
}
