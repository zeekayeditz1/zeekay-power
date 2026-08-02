import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import {
  ensureTables,
  getState,
  setState,
  logEvent,
  getEvents,
} from "../services/dashboardStore";
import { runSocTick } from "../services/socPipeline";
import { setTuyaRelay, fetchTuyaStatus } from "../services/tuya";

/*
|--------------------------------------------------------------------------
| Dashboard routes (JWT protected)
|--------------------------------------------------------------------------
| These power the Zeekay Power control center UI. Live values are currently
| generated from a self-consistent demo model so the dashboard is fully
| functional today. Each place that should read/write real hardware is
| marked with `TODO(tuya)` / `TODO(sems)` for drop-in wiring later.
|--------------------------------------------------------------------------
*/

const dashboard = new Hono();

dashboard.use("*", async (c, next) => {
  await ensureTables(c.env as any);
  return next();
});
dashboard.use("*", authMiddleware);

/* ---------- shared, self-consistent demo model ---------- */

// 0 at night, 1 at solar noon (approx 06:00–18:00 daylight window)
function daylight(d: Date): number {
  const mins = d.getHours() * 60 + d.getMinutes();
  return Math.max(0, Math.sin(((mins - 360) / 720) * Math.PI));
}

function socAt(d: Date): number {
  // 45% overnight floor rising toward ~90% at peak sun
  return Math.round(45 + 45 * daylight(d));
}

function solarAt(d: Date): number {
  return Math.round(3200 * daylight(d));
}

function toIso(s: string | null): string | null {
  if (!s) return s;
  return s.includes("T") ? s : s.replace(" ", "T") + "Z";
}

async function snapshot(env: any) {
  const now = new Date();
  const relay = parseInt(await getState(env, "relay_state", "1"), 10) === 1 ? 1 : 0;
  const mode = await getState(env, "mode", "auto");

  try {
    const raw = await getState(env, "live_status", "");
    if (raw) {
      const s = JSON.parse(raw);
      let tuya: any = null;
      try { const traw = await getState(env, "tuya_status", ""); if (traw) tuya = JSON.parse(traw); } catch {}
      const relayReal = tuya ? (tuya.relay_on ? 1 : 0) : relay;
      const wapda = (s.grid_power ?? 0) > 5 || (s.ac_voltage ?? 0) > 50 || ((tuya?.grid_voltage ?? 0) > 50);
      const soc = s.battery_soc ?? 0;
      const socLabel = soc >= 70 ? "HIGH" : soc >= 35 ? "MEDIUM" : "LOW";
      const charging = !!s.battery_charging;
      const bstate = charging ? "charging" : (s.battery_power ?? 0) < -20 ? "discharging" : "idle";
      return {
        source: "live",
        battery_soc: soc,
        battery_soc_label: socLabel,
        bms_soc: s.bms_soc,
        battery_voltage: s.battery_voltage,
        battery_current: s.battery_current,
        battery_power: s.battery_power,
        battery_charging: charging,
        battery_state: bstate,
        soc_voltage: s.soc_voltage,
        soc_coulomb: s.soc_coulomb,
        usable_capacity_ah: s.usable_capacity_ah,
        solar_power: s.solar_power,
        solar_peak_today: s.solar_peak_today,
        pv_today_kwh: s.pv_today_kwh,
        load_power: s.load_power,
        voltage: s.load_voltage,
        current: s.load_current,
        power: s.load_power,
        energy_today: s.pv_today_kwh,
        grid_power: s.grid_power,
        frequency: s.frequency,
        meter_total_kwh: s.meter_total_kwh,
        wapda,
        relay_state: relayReal,
        relay_closed: relayReal === 1,
        mode,
        charge_from_solar_kwh: s.charge_from_solar_kwh,
        charge_from_wapda_kwh: s.charge_from_wapda_kwh,
        total_charge_kwh: s.total_charge_kwh,
        discharge_24h_kwh: s.discharge_24h_kwh,
        breaker_online: s.breaker_online,
        updated_at: s.updated_at,
      };
    }
  } catch {}

  const soc = socAt(now);
  const solar = solarAt(now);
  const load = Math.round(620 + 380 * Math.abs(Math.sin(now.getTime() / 120000)));
  const wapda = relay === 1;
  const batteryVoltage = +(48 + ((soc - 45) / 45) * 6).toFixed(1);
  const acVoltage = wapda ? +(228 + 4 * Math.sin(now.getTime() / 90000)).toFixed(1) : 0;
  return {
    source: "demo",
    battery_soc: soc,
    battery_soc_label: soc >= 70 ? "HIGH" : soc >= 35 ? "MEDIUM" : "LOW",
    battery_voltage: batteryVoltage,
    solar_power: solar,
    solar_peak_today: solar,
    pv_today_kwh: 0,
    load_power: load,
    voltage: acVoltage,
    current: acVoltage > 0 ? +(load / acVoltage).toFixed(1) : 0,
    power: load,
    energy_today: 0,
    grid_power: 0,
    frequency: wapda ? 50 : 0,
    meter_total_kwh: 0,
    wapda,
    relay_state: relay,
    relay_closed: relay === 1,
    mode,
    charge_from_solar_kwh: 0,
    charge_from_wapda_kwh: 0,
    total_charge_kwh: 0,
    discharge_24h_kwh: 0,
    updated_at: now.toISOString(),
  };
}

/* ---------- GET /api/status ---------- */
dashboard.get("/status", async (c) => {
  const status = await snapshot(c.env as any);
  return c.json({ success: true, status });
});

/* ---------- GET /api/history?hours=24 ---------- */
dashboard.get("/history", async (c) => {
  const hours = Math.max(1, Math.min(48, parseInt(c.req.query("hours") || "24", 10) || 24));
  const stepMin = hours <= 6 ? 15 : hours <= 12 ? 30 : 60;

  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  try {
    const res: any = await (c.env as any).zeekay_power_db
      .prepare(`SELECT ts, soc_blended FROM battery_history WHERE ts >= ? ORDER BY ts ASC`)
      .bind(since)
      .all();
    const rows = res?.results || [];
    if (rows.length) {
      const points = rows.map((r: any) => ({ t: new Date(r.ts * 1000).toISOString(), soc: Math.round(r.soc_blended) }));
      return c.json({ success: true, hours, points });
    }
  } catch {}

  const points: { t: string; soc: number }[] = [];
  for (let t = hours * 60; t >= 0; t -= stepMin) {
    const d = new Date(Date.now() - t * 60000);
    points.push({ t: d.toISOString(), soc: socAt(d) });
  }
  return c.json({ success: true, hours, points });
});

/* ---------- GET /api/events?limit=8 ---------- */
dashboard.get("/events", async (c) => {
  const limit = parseInt(c.req.query("limit") || "8", 10) || 8;
  const rows = await getEvents(c.env as any, limit);
  const events = rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    detail: r.detail,
    at: toIso(r.at),
  }));
  return c.json({ success: true, events });
});

/* ---------- POST /api/relay { state: 0|1 } ---------- */
dashboard.post("/relay", async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    /* ignore */
  }

  const next = body && (body.state === 1 || body.state === true || body.state === "1") ? 1 : 0;

  try {
    await setTuyaRelay(c.env as any, next === 1);
  } catch (e: any) {
    return c.json({ success: false, error: "tuya command failed: " + (e?.message || e) }, 502);
  }
  await setState(c.env as any, "relay_state", String(next));
  try {
    const ts = await fetchTuyaStatus(c.env as any);
    await setState(c.env as any, "tuya_status", JSON.stringify(ts));
  } catch { /* read-back best-effort */ }
  await logEvent(
    c.env as any,
    "relay",
    `WAPDA relay ${next ? "closed (ON)" : "opened (OFF)"}`,
    "Manual override from dashboard"
  );

  return c.json({ success: true, relay_state: next });
});

/* ---------- POST /api/poll ---------- */
dashboard.post("/poll", async (c) => {
  try { await runSocTick(c.env as any); } catch (e: any) { console.error("poll tick:", e?.message); }
  await logEvent(
    c.env as any,
    "system",
    "Manual poll requested",
    "Fetched latest device + inverter data"
  );

  const status = await snapshot(c.env as any);
  return c.json({ success: true, polled: true, at: new Date().toISOString(), status });
});

export default dashboard;
