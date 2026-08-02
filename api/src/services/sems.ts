/*
| Real SEMS+ client (verified live against hk.semsportal.com, 2026-07-29).
| Handles regional CrossLogin (plain password), token caching in D1 app_state,
| and normalizes the monitor payload into the fields the dashboard + SOC need.
*/
import { getState, setState } from "./dashboardStore";

export interface Env {
  SEMS_EMAIL: string;
  SEMS_PASSWORD: string;
  SEMS_STATION_ID: string;
  zeekay_power_db: D1Database;
}

const BASE = "https://hk.semsportal.com";
const okCode = (c: any) => String(c) === "0";
const numOf = (x: any) => { const n = parseFloat(String(x)); return Number.isFinite(n) ? n : null; };

async function crossLogin(env: Env) {
  const r = await fetch(`${BASE}/api/v2/Common/CrossLogin`, {
    method: "POST",
    headers: { "Content-Type": "application/json",
      Token: JSON.stringify({ version: "v2.1.0", client: "web", language: "en" }) },
    body: JSON.stringify({ account: env.SEMS_EMAIL, pwd: env.SEMS_PASSWORD }),
  });
  const d: any = await r.json();
  if (!okCode(d.code) || !d.data) throw new Error(`SEMS login failed: code=${d.code} msg=${d.msg}`);
  const tok = { ...d.data, exp: Date.now() + 50 * 60000 };
  await setState(env as any, "sems_token", JSON.stringify(tok));
  return tok;
}
async function getToken(env: Env) {
  try {
    const raw = await getState(env as any, "sems_token", "");
    if (raw) { const t = JSON.parse(raw); if (t && t.exp > Date.now()) return t; }
  } catch {}
  return crossLogin(env);
}
async function monitorCall(tok: any, station: string) {
  const r = await fetch(`${BASE}/api/v3/PowerStation/GetMonitorDetailByPowerstationId`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Token: JSON.stringify(tok) },
    body: JSON.stringify({ powerStationId: station }),
  });
  return r.json() as Promise<any>;
}

export interface SemsSnapshot {
  v: number | null; p_chg: number | null; ts: number; bms_soc: number | null;
  solar_power: number | null; load_power: number | null; grid_power: number | null;
  ac_voltage: number | null;
  energy_today: number | null;
  load_voltage: number | null;
  load_current: number | null;
  battery_current: number | null;
  frequency: number | null;
  meter_total_kwh: number | null;
  wapda_today_kwh: number | null;
  charge_day_kwh: number | null;
  discharge_day_kwh: number | null;
  pv_power: number | null;
}

/** Pull one live reading. p_chg: POSITIVE = charging (SEMS reports negative for charge). */
export async function fetchSemsSnapshot(env: Env): Promise<SemsSnapshot> {
  let tok = await getToken(env);
  let d = await monitorCall(tok, env.SEMS_STATION_ID);
  if (String(d.code) === "100002" || String(d.code) === "100001") { tok = await crossLogin(env); d = await monitorCall(tok, env.SEMS_STATION_ID); }
  if (!okCode(d.code)) throw new Error(`SEMS monitor failed: code=${d.code} msg=${d.msg}`);

  const data = d.data || {};
  const inv = data.inverter?.[0] || {};
  const full = inv.invert_full || {};
  const pf = data.powerflow || {};
  const power = numOf(full.total_pbattery ?? inv.battery_power);
  return {
    v: numOf(full.vbattery1),
    p_chg: power == null ? null : -power,
    ts: Math.floor(Date.now() / 1000),
    bms_soc: numOf(full.soc ?? inv.soc ?? pf.soc),
    solar_power: numOf(pf.pv),
    load_power: numOf(pf.load),
    grid_power: numOf(pf.grid),
    ac_voltage: numOf(full.vload ?? full.output_voltage ?? inv.output_voltage),
    energy_today: numOf(full.eday ?? inv.eday),
    load_voltage: numOf(full.vload),
    load_current: numOf(full.iload),
    battery_current: numOf(full.ibattery1),
    frequency: numOf(full.fac1),
    // real inverter counters — fixes prior null (was reading full.eday_buy, which
    // doesn't exist; the real fields live on `inv`, snake_case, and on `full` as camelCase)
    meter_total_kwh: numOf(inv.etotal_buy ?? full.eTotalBuy),
    wapda_today_kwh: numOf(inv.eday_buy ?? full.eDayBuy),
    charge_day_kwh: numOf(full.eChargeDay),
    discharge_day_kwh: numOf(full.eDischargeDay),
    pv_power: numOf(pf.pv ?? full.pv_power),
  };
}

export function health(env: Env) {
  return { ready: !!(env.SEMS_EMAIL && env.SEMS_PASSWORD && env.SEMS_STATION_ID) };
}
export default { fetchSemsSnapshot, health };
