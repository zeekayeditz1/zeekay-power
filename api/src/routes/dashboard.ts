import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import {
  ensureTables,
  getState,
  setState,
  logEvent,
  getEvents,
} from "../services/dashboardStore";

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

  const soc = socAt(now);
  const solar = solarAt(now);
  const load = Math.round(620 + 380 * Math.abs(Math.sin(now.getTime() / 120000)));
  const wapda = relay === 1; // mains transfer relay closed => grid available
  const batteryVoltage = +(48 + ((soc - 45) / 45) * 6).toFixed(1); // 48–54 V pack
  const acVoltage = wapda ? +(228 + 4 * Math.sin(now.getTime() / 90000)).toFixed(1) : 0;
  const power = load;
  const current = acVoltage > 0 ? +(power / acVoltage).toFixed(1) : 0;
  const energyToday = +(((now.getHours() * 60 + now.getMinutes()) / 1440) * 17.4).toFixed(2);

  return {
    battery_soc: soc,
    battery_voltage: batteryVoltage,
    solar_power: solar,          // TODO(sems): real PV power from GoodWe/SEMS
    load_power: load,            // TODO(sems): real load power
    voltage: acVoltage,          // TODO(sems)
    current,                     // TODO(sems)
    power,                       // TODO(sems)
    energy_today: energyToday,   // TODO(sems): kWh generated today
    wapda,                       // TODO(tuya): real mains-present sense
    relay_state: relay,          // TODO(tuya): real relay state read-back
    mode,
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

  // TODO(tuya): call Tuya cloud API here to physically switch the relay.
  //   await setTuyaRelay(c.env, next);

  await setState(c.env as any, "relay_state", String(next));
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
  // TODO(tuya)/TODO(sems): refresh live device + inverter data on demand.
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
