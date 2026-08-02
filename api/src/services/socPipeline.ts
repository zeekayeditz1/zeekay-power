/*
| SOC + energy pipeline: pull SEMS, run estimator, read Tuya breaker, persist a
| rich live_status for /api/status, log a daily energy row (real inverter
| counters — grid import, charge, discharge) for billing-cycle history, and
| run the voltage-triggered auto-shift-to-WAPDA automation.
| Runs every minute (cron) and on-demand via /api/poll.
*/
import { fetchSemsSnapshot } from "./sems";
import { step, SocState } from "./soc";
import { fetchTuyaStatus, setTuyaRelay, tuyaConfigured } from "./tuya";
import { getState, setState, ensureTables, logEvent } from "./dashboardStore";

const r2 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 100) / 100);
// Pakistan is UTC+5 (no DST) — local calendar day for "today" counters & the billing-cycle grouping.
function localDay(ts_s: number) { return new Date((ts_s + 5 * 3600) * 1000).toISOString().slice(0, 10); }

const AUTOSHIFT_DEFAULT = { enabled: false, threshold_v: 45.8, duration_min: 60, pv_stop_w: 200 };

export async function runSocTick(env: any) {
  await ensureTables(env);

  // Guard against overlapping runs — the 1-minute cron and a manual "Force poll"
  // click can land close together, and without this two concurrent ticks could
  // both decide independently to fire a Tuya relay command or race on writing
  // autoshift_state. 50s TTL is comfortably under the 60s cron interval, so it
  // never blocks normal sequential ticks, only true overlaps.
  const nowEpoch = Math.floor(Date.now() / 1000);
  let lockRaw = "";
  try { lockRaw = await getState(env, "tick_lock", ""); } catch {}
  if (lockRaw) {
    const lockTs = parseInt(lockRaw, 10);
    if (Number.isFinite(lockTs) && nowEpoch - lockTs < 50) {
      throw new Error("SOC tick already running \u2014 skipped an overlapping call");
    }
  }
  await setState(env, "tick_lock", String(nowEpoch));

  const snap = await fetchSemsSnapshot(env);
  if (snap.v == null || snap.p_chg == null) throw new Error("bad SEMS sample");

  // --- SOC estimator ---
  let prev: SocState = {};
  try { const raw = await getState(env, "soc_state", ""); if (raw) prev = JSON.parse(raw); } catch {}
  const out = step(prev, { v: snap.v, p_chg: snap.p_chg, ts: snap.ts, bms_soc: snap.bms_soc });
  out.bms_soc = snap.bms_soc;
  await setState(env, "soc_state", JSON.stringify(out));

  // --- history row (voltage, battery power, soc) ---
  await env.zeekay_power_db.prepare(
    `INSERT OR REPLACE INTO battery_history (ts,v,p,soc_blended,soc_v,soc_cc,bms_soc,anchored)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(snap.ts, snap.v, snap.p_chg, r2(out.blended), r2(out.soc_v), r2(out.soc_cc), snap.bms_soc, out.anchored ? 1 : 0).run();

  // --- Tuya breaker (best-effort) ---
  let tuya: any = null;
  let tuyaReadFailed = false;
  try {
    if (tuyaConfigured(env)) { tuya = await fetchTuyaStatus(env); await setState(env, "tuya_status", JSON.stringify(tuya)); }
  } catch (e: any) { tuyaReadFailed = true; console.error("tuya read:", e?.message); }

  // Log only on a REACHABILITY TRANSITION (not every tick) so a prolonged outage
  // doesn't spam the events feed, but the moment it goes down or comes back is
  // always visible on the dashboard — previously this was invisible anywhere.
  if (tuyaConfigured(env)) {
    let wasReachable = true;
    try { wasReachable = (await getState(env, "tuya_reachable", "1")) !== "0"; } catch {}
    const nowReachable = !tuyaReadFailed;
    if (wasReachable && !nowReachable) {
      await logEvent(env, "breaker", "WAPDA breaker unreachable",
        "Tuya cloud API call failed \u2014 auto-shift automation is paused until it reconnects");
    } else if (!wasReachable && nowReachable) {
      await logEvent(env, "breaker", "WAPDA breaker reconnected",
        "Tuya cloud API is responding again \u2014 auto-shift automation resumed");
    }
    try { await setState(env, "tuya_reachable", nowReachable ? "1" : "0"); } catch {}
  }

  // --- daily accumulator: PV peak (not provided by SEMS) + solar/WAPDA charge SPLIT RATIO ---
  // (magnitudes for charge/discharge now come straight from the inverter's own
  // day counters below — real meter readings, not our own integration — this
  // accumulator only tracks the proportion of charging that was solar-fed.)
  const today = localDay(snap.ts);
  let acc: any = {};
  try { const raw = await getState(env, "daily_energy", ""); if (raw) acc = JSON.parse(raw); } catch {}
  if (acc.date !== today) acc = { date: today, pv_peak_w: 0, charge_solar_wh: 0, charge_wapda_wh: 0, last_ts: snap.ts };
  const dt_h = acc.last_ts ? Math.min(600, Math.max(0, snap.ts - acc.last_ts)) / 3600 : 0;
  acc.pv_peak_w = Math.max(acc.pv_peak_w || 0, snap.solar_power || 0);
  const bp = snap.p_chg || 0; // +charge / -discharge (W)
  const wapdaOn = (tuya && tuya.relay_on) || (snap.grid_power || 0) > 20;
  if (bp > 20 && dt_h > 0) {
    const wh = bp * dt_h;
    const solarStrong = (snap.solar_power || 0) >= bp || (snap.solar_power || 0) > (snap.load_power || 0);
    if (solarStrong || !wapdaOn) acc.charge_solar_wh += wh; else acc.charge_wapda_wh += wh;
  }
  acc.last_ts = snap.ts;
  await setState(env, "daily_energy", JSON.stringify(acc));

  // Real total charge/discharge today, straight from the inverter's own counters.
  const realChargeKwh = snap.charge_day_kwh ?? 0;
  const realDischargeKwh = snap.discharge_day_kwh ?? 0;
  const splitTotal = (acc.charge_solar_wh || 0) + (acc.charge_wapda_wh || 0);
  const solarRatio = splitTotal > 0 ? (acc.charge_solar_wh || 0) / splitTotal : 1;
  const chargeFromSolarKwh = realChargeKwh * solarRatio;
  const chargeFromWapdaKwh = realChargeKwh * (1 - solarRatio);

  // --- persist today's real counters for billing-cycle / monthly history ---
  await env.zeekay_power_db.prepare(
    `INSERT INTO daily_energy_log (date, wapda_import_kwh, solar_kwh, charge_kwh, discharge_kwh, pv_peak_w)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(date) DO UPDATE SET
       wapda_import_kwh=excluded.wapda_import_kwh, solar_kwh=excluded.solar_kwh,
       charge_kwh=excluded.charge_kwh, discharge_kwh=excluded.discharge_kwh,
       pv_peak_w=MAX(daily_energy_log.pv_peak_w, excluded.pv_peak_w)`
  ).bind(today, r2(snap.wapda_today_kwh) ?? 0, r2(snap.energy_today) ?? 0, r2(realChargeKwh) ?? 0, r2(realDischargeKwh) ?? 0, Math.round(acc.pv_peak_w || 0)).run();

  // --- auto-shift-to-WAPDA (voltage-triggered, fixed-duration) ---
  let cfg = { ...AUTOSHIFT_DEFAULT };
  try { const raw = await getState(env, "autoshift_cfg", ""); if (raw) cfg = { ...cfg, ...JSON.parse(raw) }; } catch {}
  let asState: any = { active: false, trigger_ts: null, until_ts: null, trigger_voltage: null };
  try { const raw = await getState(env, "autoshift_state", ""); if (raw) asState = { ...asState, ...JSON.parse(raw) }; } catch {}

  // Fixed nighttime trigger window: 18:00 (6 PM) through 05:59 (just before 6 AM), Pakistan local time.
  const localHour = new Date((snap.ts + 5 * 3600) * 1000).getUTCHours();
  const inNightWindow = localHour >= 18 || localHour < 6;

  if (cfg.enabled && tuya) {
    const nowTs = snap.ts;
    if (!asState.active) {
      if (inNightWindow && snap.v <= cfg.threshold_v && !tuya.relay_on) {
        try {
          await setTuyaRelay(env, true);
          asState = { active: true, trigger_ts: nowTs, until_ts: nowTs + cfg.duration_min * 60, trigger_voltage: snap.v };
          await logEvent(env, "autoshift", "Auto-shift: WAPDA turned ON",
            `Battery at ${snap.v.toFixed(1)} V (\u2264 ${cfg.threshold_v} V threshold, ${localHour}:00 local) \u2014 will hold up to ${cfg.duration_min} min or until PV \u2265 ${cfg.pv_stop_w} W`);
        } catch (e: any) { console.error("autoshift ON failed:", e?.message); }
      }
    } else {
      // While holding, either of two things can end it early, before the fixed
      // duration is up: PV recovering past the stop threshold, OR WAPDA itself
      // genuinely coming back (confirmed via grid_power/ac_voltage from the
      // inverter — not just "the relay reports closed", which tells you nothing
      // if the grid line itself has no power). If NEITHER happens, the duration
      // is the only fallback — and the battery keeps discharging the whole time,
      // because closing a relay cannot create power that isn't there.
      const pvNow = snap.solar_power ?? 0;
      const gridConfirmed = (snap.grid_power ?? 0) > 20 || (snap.ac_voltage ?? 0) > 50;
      if (pvNow >= cfg.pv_stop_w || gridConfirmed) {
        try {
          await setTuyaRelay(env, false);
          const reason = gridConfirmed
            ? `WAPDA power confirmed present (grid ${Math.round(snap.grid_power ?? 0)} W, ${Math.round(snap.ac_voltage ?? 0)} V) \u2014 ended early`
            : `PV reached ${Math.round(pvNow)} W (\u2265 ${cfg.pv_stop_w} W stop threshold) \u2014 ended early`;
          await logEvent(env, "autoshift", "Auto-shift: WAPDA turned OFF", reason);
        } catch (e: any) { console.error("autoshift OFF (recovery) failed:", e?.message); }
        asState = { active: false, trigger_ts: null, until_ts: null, trigger_voltage: null };
      } else if (nowTs >= (asState.until_ts || 0)) {
        try {
          await setTuyaRelay(env, false);
          await logEvent(env, "autoshift", "Auto-shift: WAPDA turned OFF",
            `${cfg.duration_min} min elapsed with no PV or WAPDA recovery detected \u2014 battery kept discharging the whole hold; will retry if voltage is still low next tick`);
        } catch (e: any) { console.error("autoshift OFF failed:", e?.message); }
        asState = { active: false, trigger_ts: null, until_ts: null, trigger_voltage: null };
      }
    }
    await setState(env, "autoshift_state", JSON.stringify(asState));
  }

  const charging = bp > 20;
  const status = {
    // battery
    battery_soc: Math.round(out.blended ?? 0),
    battery_soc_precise: r2(out.blended),
    bms_soc: snap.bms_soc,
    soc_voltage: r2(out.soc_v),
    soc_coulomb: r2(out.soc_cc),
    battery_voltage: snap.v,
    battery_current: snap.battery_current,
    battery_power: r2(snap.p_chg),
    battery_charging: charging,
    usable_capacity_ah: r2(out.c_usable_ah),
    // solar
    solar_power: Math.round(snap.solar_power || 0),
    solar_peak_today: Math.round(acc.pv_peak_w || 0),
    pv_today_kwh: r2(snap.energy_today),
    // load / measurements (FIXED: real load V/I, not grid vac1)
    load_power: Math.round(snap.load_power || 0),
    load_voltage: r2(snap.load_voltage ?? snap.ac_voltage),
    load_current: r2(snap.load_current),
    // grid
    grid_power: Math.round(snap.grid_power || 0),
    frequency: r2((tuya && tuya.frequency_hz) || snap.frequency),
    wapda_today_kwh: r2(snap.wapda_today_kwh),
    meter_total_kwh: r2(snap.meter_total_kwh),
    ac_voltage: r2(snap.ac_voltage),
    // energy today (real counters; solar/WAPDA split estimated by ratio)
    charge_from_solar_kwh: r2(chargeFromSolarKwh),
    charge_from_wapda_kwh: r2(chargeFromWapdaKwh),
    total_charge_kwh: r2(realChargeKwh),
    discharge_today_kwh: r2(realDischargeKwh),
    // breaker
    breaker_online: tuya ? tuya.online : null,
    breaker_energy_kwh: tuya ? tuya.energy_total_kwh : null,
    // autoshift status (for the settings card)
    autoshift_active: asState.active,
    autoshift_until: asState.until_ts ? new Date(asState.until_ts * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  await setState(env, "live_status", JSON.stringify(status));
  return status;
}
