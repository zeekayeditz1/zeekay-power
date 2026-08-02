/*
| SOC + energy pipeline: pull SEMS, run estimator, read Tuya breaker, accumulate
| daily energy (charge split by source, PV peak) and 24h discharge, then persist
| a rich live_status for /api/status. Runs every minute (cron) and on /api/poll.
*/
import { fetchSemsSnapshot } from "./sems";
import { step, SocState } from "./soc";
import { fetchTuyaStatus, tuyaConfigured } from "./tuya";
import { getState, setState, ensureTables } from "./dashboardStore";

const r2 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 100) / 100);
// Pakistan is UTC+5 (no DST) — local calendar day for "today" counters.
function localDay(ts_s: number) { return new Date((ts_s + 5 * 3600) * 1000).toISOString().slice(0, 10); }

export async function runSocTick(env: any) {
  await ensureTables(env);
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
  try { if (tuyaConfigured(env)) { tuya = await fetchTuyaStatus(env); await setState(env, "tuya_status", JSON.stringify(tuya)); } } catch (e: any) { console.error("tuya read:", e?.message); }

  // --- daily energy accumulators (charge split by source + PV peak) ---
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

  // --- 24h discharge integral from history ---
  let dis24_wh = 0;
  try {
    const since = snap.ts - 86400;
    const res: any = await env.zeekay_power_db.prepare(`SELECT ts,p FROM battery_history WHERE ts>=? ORDER BY ts ASC`).bind(since).all();
    const rows = res?.results || [];
    let prevR: any = null;
    for (const rr of rows) { if (prevR && prevR.p < 0) { const dt = Math.min(600, Math.max(0, rr.ts - prevR.ts)) / 3600; dis24_wh += -prevR.p * dt; } prevR = rr; }
  } catch {}

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
    meter_total_kwh: r2(snap.meter_total_kwh),
    ac_voltage: r2(snap.ac_voltage),
    // energy today
    charge_from_solar_kwh: r2((acc.charge_solar_wh || 0) / 1000),
    charge_from_wapda_kwh: r2((acc.charge_wapda_wh || 0) / 1000),
    total_charge_kwh: r2(((acc.charge_solar_wh || 0) + (acc.charge_wapda_wh || 0)) / 1000),
    discharge_24h_kwh: r2(dis24_wh / 1000),
    // breaker
    breaker_online: tuya ? tuya.online : null,
    breaker_energy_kwh: tuya ? tuya.energy_total_kwh : null,
    updated_at: new Date().toISOString(),
  };
  await setState(env, "live_status", JSON.stringify(status));
  return status;
}
