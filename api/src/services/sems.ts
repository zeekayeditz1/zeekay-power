/*
| Real SEMS+ client (verified live against hk.semsportal.com, 2026-07-29).
| Handles regional CrossLogin (plain password), token caching in D1 app_state,
| and normalizes the monitor payload into the fields the dashboard + SOC need.
*/
import { getState, setState } from "./dashboardStore";
import { SEMS_MAX_SAMPLE_AGE_S } from "./telemetry";

export interface Env {
  SEMS_EMAIL: string;
  SEMS_PASSWORD: string;
  SEMS_STATION_ID: string;
  zeekay_power_db: D1Database;
}

const BASE = "https://hk.semsportal.com";
// A hung upstream must not hold the whole cron tick open — every SEMS call is
// bounded so a stall surfaces as a normal error instead of a stuck worker.
const REQUEST_TIMEOUT_MS = 12000;
const okCode = (c: any) => String(c) === "0";
const numOf = (x: any) => { const n = parseFloat(String(x)); return Number.isFinite(n) ? n : null; };

async function fetchJson(url: string, init: RequestInit, operation: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${operation} HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new Error(`${operation} returned invalid JSON`);
    }
  } catch (error: any) {
    if (error?.name === "AbortError") throw new Error(`${operation} timed out`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function crossLogin(env: Env) {
  if (!env.SEMS_EMAIL || !env.SEMS_PASSWORD || !env.SEMS_STATION_ID) {
    throw new Error("SEMS is not configured");
  }
  const d: any = await fetchJson(`${BASE}/api/v2/Common/CrossLogin`, {
    method: "POST",
    headers: { "Content-Type": "application/json",
      Token: JSON.stringify({ version: "v2.1.0", client: "web", language: "en" }) },
    body: JSON.stringify({ account: env.SEMS_EMAIL, pwd: env.SEMS_PASSWORD }),
  }, "SEMS login");
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
  return fetchJson(`${BASE}/api/v3/PowerStation/GetMonitorDetailByPowerstationId`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Token: JSON.stringify(tok) },
    body: JSON.stringify({ powerStationId: station }),
  }, "SEMS monitor");
}

export interface SemsSnapshot {
  v: number | null; p_chg: number | null; ts: number; bms_soc: number | null;
  solar_power: number | null; load_power: number | null; grid_power: number | null;
  /* Inverter OUTPUT voltage — the AC the house runs on. It is present whether
     the load is fed by battery, solar or WAPDA, so it is never evidence that
     mains is available. (Named ac_voltage before, which invited exactly that
     mistake.) */
  output_voltage: number | null;
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
export function hardwareSampleTime(inv:any,full:any):number|null {
  const value=full.last_time??inv.last_time??full.lastTime??inv.lastTime;
  if(value==null||value==="") return null;
  if(typeof value==="number") return value>1e12?Math.floor(value/1000):Math.floor(value);
  const asp=/^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/.exec(String(value));
  if(asp) return Math.floor(Number(asp[1])/1000);
  let text=String(value).trim().replace(/\//g,"-").replace(" ","T");
  const english=/^(\d{1,2})-(\d{1,2})-(\d{4})T(\d{2}:\d{2}(?::\d{2})?)$/.exec(text);
  if(english) text=`${english[3]}-${english[1].padStart(2,"0")}-${english[2].padStart(2,"0")}T${english[4]}`;
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) text+="+05:00";
  const ms=Date.parse(text); return Number.isFinite(ms)?Math.floor(ms/1000):null;
}
export async function fetchSemsSnapshot(env: Env): Promise<SemsSnapshot> {
  let tok = await getToken(env);
  let d = await monitorCall(tok, env.SEMS_STATION_ID);
  if (String(d.code) === "100002" || String(d.code) === "100001") { tok = await crossLogin(env); d = await monitorCall(tok, env.SEMS_STATION_ID); }
  if (!okCode(d.code)) throw new Error(`SEMS monitor failed: code=${d.code} msg=${d.msg}`);

  const data = d.data || {};
  const inv = data.inverter?.[0] || {};
  const full = inv.invert_full || {};
  const pf = data.powerflow || {};
  const sampleTs=hardwareSampleTime(inv,full),now=Math.floor(Date.now()/1000);
  await setState(env as any,"sems_telemetry_health",JSON.stringify({sample_ts:sampleTs,polled_ts:now,sample_age_s:sampleTs==null?null:now-sampleTs,device_status:inv.status??null,has_device_time:sampleTs!=null}));
  if(inv.status===-1||inv.status==="-1"||inv.online===false||sampleTs==null||now-sampleTs>SEMS_MAX_SAMPLE_AGE_S||sampleTs>now+30) throw new Error("Inverter hardware reading is unavailable or delayed");
  const power = numOf(full.total_pbattery ?? inv.battery_power);
  return {
    v: numOf(full.vbattery1),
    p_chg: power == null ? null : -power,
    ts: sampleTs,
    bms_soc: numOf(full.soc ?? inv.soc ?? pf.soc),
    solar_power: numOf(pf.pv),
    load_power: numOf(pf.load),
    grid_power: numOf(pf.grid),
    output_voltage: numOf(full.vload ?? full.output_voltage ?? inv.output_voltage),
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
