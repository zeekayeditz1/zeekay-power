/*
| Tuya Cloud client — verified live on Central Europe DC (openapi.tuyaeu.com), 2026-08-01.
| WiFi WAPDA metering breaker "Intelligent switch". Reads relay state + grid metrics
| and can switch the breaker. HMAC-SHA256 request signing via Web Crypto.
*/
import { getState, setState } from "./dashboardStore";

export interface TuyaEnv {
  TUYA_CLIENT_ID: string;
  TUYA_CLIENT_SECRET: string;
  TUYA_DEVICE_ID: string;
  TUYA_REGION: string; // full base URL or short code eu/us/in/cn (defaults eu)
  zeekay_power_db: D1Database;
}

const BASES: Record<string, string> = {
  eu: "https://openapi.tuyaeu.com", us: "https://openapi.tuyaus.com",
  in: "https://openapi.tuyain.com", cn: "https://openapi.tuyacn.com",
};
function baseUrl(env: TuyaEnv) {
  const r = (env.TUYA_REGION || "eu").trim();
  return r.startsWith("http") ? r.replace(/\/+$/, "") : (BASES[r] || BASES.eu);
}

const enc = new TextEncoder();
async function sha256Hex(s: string) {
  const b = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function hmacHex(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(s)].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}
async function signedFetch(env: TuyaEnv, token: string, method: string, path: string, body = "") {
  const t = Date.now().toString();
  const contentHash = await sha256Hex(body);
  const stringToSign = `${method}\n${contentHash}\n\n${path}`;
  const signStr = token ? env.TUYA_CLIENT_ID + token + t + stringToSign : env.TUYA_CLIENT_ID + t + stringToSign;
  const sign = await hmacHex(env.TUYA_CLIENT_SECRET, signStr);
  const headers: Record<string, string> = { client_id: env.TUYA_CLIENT_ID, sign, t, sign_method: "HMAC-SHA256", "Content-Type": "application/json" };
  if (token) headers["access_token"] = token;
  const res = await fetch(baseUrl(env) + path, { method, headers, body: body || undefined });
  return res.json() as Promise<any>;
}
async function getToken(env: TuyaEnv): Promise<string> {
  try { const raw = await getState(env as any, "tuya_token", ""); if (raw) { const c = JSON.parse(raw); if (c && c.exp > Date.now()) return c.token; } } catch {}
  const d = await signedFetch(env, "", "GET", "/v1.0/token?grant_type=1");
  if (!d.success || !d.result?.access_token) throw new Error(`tuya token: code=${d.code} ${d.msg}`);
  await setState(env as any, "tuya_token", JSON.stringify({ token: d.result.access_token, exp: Date.now() + (d.result.expire_time - 120) * 1000 }));
  return d.result.access_token;
}
/** Signed call that transparently refreshes an expired/invalid token and retries once.
 *  Used for BOTH reads and the relay command — previously only the read path had this,
 *  meaning a stale cached token could make a relay switch silently fail with no retry. */
async function callWithTokenRetry(env: TuyaEnv, method: string, path: string, body = ""): Promise<any> {
  let token = await getToken(env);
  let d = await signedFetch(env, token, method, path, body);
  if (String(d.code) === "1010" || String(d.code) === "1011") {
    await setState(env as any, "tuya_token", "");
    token = await getToken(env);
    d = await signedFetch(env, token, method, path, body);
  }
  return d;
}
// Tuya phase_a raw: [V:2B @0.1V][I:3B @0.001A][P:3B @1W]
function decodePhase(b64?: string) {
  if (!b64) return null;
  try {
    const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    if (u.length < 8) return null;
    return { voltage: ((u[0] << 8) | u[1]) / 10, current: ((u[2] << 16) | (u[3] << 8) | u[4]) / 1000, power: (u[5] << 16) | (u[6] << 8) | u[7] };
  } catch { return null; }
}

export interface TuyaStatus {
  online: boolean; relay_on: boolean; relay_status: string;
  grid_voltage: number | null; grid_current: number | null; grid_power: number | null;
  frequency_hz: number | null; energy_total_kwh: number | null; fault: number | null; updated_at: string;
}
export async function fetchTuyaStatus(env: TuyaEnv): Promise<TuyaStatus> {
  const d = await callWithTokenRetry(env, "GET", `/v1.0/devices/${env.TUYA_DEVICE_ID}/status`);
  if (!d.success) throw new Error(`tuya status: code=${d.code} ${d.msg}`);
  const m: Record<string, any> = {}; for (const x of d.result) m[x.code] = x.value;
  const ph = decodePhase(m.phase_a);
  const relayStatus = m.relay_status ?? (m.switch ? "power_on" : "power_off");
  return {
    online: (m.online_state ?? "online") === "online",
    relay_on: relayStatus === "power_on" || m.switch === true,
    relay_status: String(relayStatus),
    grid_voltage: ph ? ph.voltage : null, grid_current: ph ? ph.current : null, grid_power: ph ? ph.power : null,
    frequency_hz: m.supply_frequency != null ? m.supply_frequency / 10 : null,
    energy_total_kwh: m.forward_energy_total != null ? m.forward_energy_total / 100 : null,
    fault: m.fault ?? null, updated_at: new Date().toISOString(),
  };
}
/** Switch the WAPDA breaker on/off (control DP is `switch`). */
export async function setTuyaRelay(env: TuyaEnv, on: boolean): Promise<boolean> {
  const body = JSON.stringify({ commands: [{ code: "switch", value: !!on }] });
  const d = await callWithTokenRetry(env, "POST", `/v1.0/devices/${env.TUYA_DEVICE_ID}/commands`, body);
  if (!d.success) throw new Error(`tuya command: code=${d.code} ${d.msg}`);
  return d.result === true || d.success === true;
}
export function tuyaConfigured(env: TuyaEnv) { return !!(env.TUYA_CLIENT_ID && env.TUYA_CLIENT_SECRET && env.TUYA_DEVICE_ID); }
export default { fetchTuyaStatus, setTuyaRelay, tuyaConfigured };
