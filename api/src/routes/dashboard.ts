import { Hono } from "hono";
import { authMiddleware, requireFullAccess } from "../middleware/auth";
import {
  ensureTables,
  getState,
  setState,
  logEvent,
  getEvents,
  acquireTickLock,
  releaseTickLock,
} from "../services/dashboardStore";
import { runSocTick } from "../services/socPipeline";
import { setTuyaRelayAndConfirm } from "../services/tuya";
import {
  AUTOSHIFT_DEFAULT,
  AutoshiftConfig,
  GridSignals,
  isGridConnected,
  isMainsAvailable,
  normalizeAutoshiftConfig,
  normalizeAutoshiftState,
} from "../services/autoshift";

/*
|--------------------------------------------------------------------------
| Dashboard routes (JWT or API key protected)
|--------------------------------------------------------------------------
| These power the Zeekay Power control center UI. Every value served here
| comes from real hardware — the SEMS+ inverter feed and the Tuya WAPDA
| breaker — via the once-a-minute pipeline in services/socPipeline.ts. When
| that data is missing or stale the response says so explicitly rather than
| substituting a plausible-looking number.
|--------------------------------------------------------------------------
*/

const dashboard = new Hono();

dashboard.use("*", async (c, next) => {
  await ensureTables(c.env as any);
  return next();
});
dashboard.use("*", authMiddleware);

function toIso(s: string | null): string | null {
  if (!s) return s;
  return s.includes("T") ? s : s.replace(" ", "T") + "Z";
}

async function snapshot(env: any) {
  const relay = parseInt(await getState(env, "relay_state", "0"), 10) === 1 ? 1 : 0;
  const mode = await getState(env, "mode", "auto");

  let tuya: any = null;
  try { const traw = await getState(env, "tuya_status", ""); if (traw) tuya = JSON.parse(traw); } catch {}
  const relayReal = tuya ? (tuya.relay_on ? 1 : 0) : relay;

  try {
    const raw = await getState(env, "live_status", "");
    if (raw) {
      const s = JSON.parse(raw);
      const signals: GridSignals = {
        relayOn: relayReal === 1,
        tuyaOnline: tuya?.online ?? s.breaker_online ?? null,
        semsGridPower: s.grid_power,
        tuyaGridPower: tuya?.grid_power,
        tuyaGridVoltage: tuya?.grid_voltage ?? s.grid_voltage,
      };
      const mainsAvailable = typeof s.mains_available === "boolean" ? s.mains_available : isMainsAvailable(signals);
      const gridConnected = typeof s.grid_connected === "boolean" ? s.grid_connected : isGridConnected(signals);

      const parsedSoc = Number(s.battery_soc);
      const soc = s.battery_soc != null && Number.isFinite(parsedSoc) ? parsedSoc : null;
      const socLabel = soc == null ? "UNAVAILABLE" : soc >= 70 ? "HIGH" : soc >= 35 ? "MEDIUM" : "LOW";
      const charging = !!s.battery_charging;
      const bstate = charging ? "charging" : (s.battery_power ?? 0) < -20 ? "discharging" : "idle";

      const updatedMs = Date.parse(s.updated_at || "");
      const sampleAgeS = Number.isFinite(updatedMs) ? Math.max(0, Math.floor((Date.now() - updatedMs) / 1000)) : null;
      const stale = sampleAgeS == null || sampleAgeS > 180;

      return {
        source: stale ? "stale" : "live",
        data_available: true,
        stale,
        sample_age_s: sampleAgeS,
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
        wapda_today_kwh: s.wapda_today_kwh,
        meter_total_kwh: s.meter_total_kwh,
        wapda: mainsAvailable,
        mains_available: mainsAvailable,
        grid_connected: gridConnected,
        grid_voltage: s.grid_voltage ?? tuya?.grid_voltage ?? null,
        relay_state: relayReal,
        relay_closed: relayReal === 1,
        mode,
        controller: "cloudflare-primary",
        charge_from_solar_kwh: s.charge_from_solar_kwh,
        charge_from_wapda_kwh: s.charge_from_wapda_kwh,
        total_charge_kwh: s.total_charge_kwh,
        discharge_today_kwh: s.discharge_today_kwh,
        breaker_online: s.breaker_online,
        autoshift_phase: s.autoshift_phase,
        autoshift_active: s.autoshift_active,
        autoshift_charging: s.autoshift_charging,
        autoshift_until: s.autoshift_until,
        autoshift_trigger_voltage: s.autoshift_trigger_voltage,
        autoshift_stop_reason: s.autoshift_stop_reason,
        autoshift_min_on_until: s.autoshift_min_on_until ?? null,
        autoshift_cooldown_until: s.autoshift_cooldown_until ?? null,
        sample_at: s.sample_at,
        updated_at: s.updated_at,
      };
    }
  } catch {}

  // No pipeline sample has ever been stored (or it failed to parse). Report
  // honestly instead of inventing values.
  const mainsAvailable = isMainsAvailable({
    relayOn: relayReal === 1,
    tuyaOnline: tuya?.online ?? null,
    tuyaGridPower: tuya?.grid_power ?? null,
    tuyaGridVoltage: tuya?.grid_voltage ?? null,
  });
  return {
    source: "unavailable",
    data_available: false,
    stale: true,
    sample_age_s: null,
    battery_soc: null,
    battery_soc_label: "UNAVAILABLE",
    bms_soc: null,
    battery_voltage: null,
    battery_current: null,
    battery_power: null,
    battery_charging: false,
    battery_state: "unavailable",
    solar_power: null,
    solar_peak_today: null,
    pv_today_kwh: null,
    load_power: null,
    voltage: null,
    current: null,
    power: null,
    energy_today: null,
    grid_power: null,
    grid_voltage: tuya?.grid_voltage ?? null,
    frequency: tuya?.frequency_hz ?? null,
    meter_total_kwh: null,
    wapda: mainsAvailable,
    mains_available: mainsAvailable,
    grid_connected: isGridConnected({
      relayOn: relayReal === 1,
      tuyaOnline: tuya?.online ?? null,
      tuyaGridPower: tuya?.grid_power,
      tuyaGridVoltage: tuya?.grid_voltage,
    }),
    relay_state: relayReal,
    relay_closed: relayReal === 1,
    mode,
    controller: "cloudflare-primary",
    charge_from_solar_kwh: null,
    charge_from_wapda_kwh: null,
    total_charge_kwh: null,
    wapda_today_kwh: null,
    discharge_today_kwh: null,
    breaker_online: tuya?.online ?? null,
    autoshift_phase: "idle",
    autoshift_active: false,
    autoshift_charging: false,
    autoshift_until: null,
    autoshift_trigger_voltage: null,
    updated_at: null,
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
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  try {
    const res: any = await (c.env as any).zeekay_power_db
      .prepare(`SELECT ts, soc_blended FROM battery_history WHERE ts >= ? ORDER BY ts ASC`)
      .bind(since)
      .all();
    const rows = res?.results || [];
    const points = rows
      .filter((r: any) => r.ts != null && r.soc_blended != null && Number.isFinite(Number(r.ts)) && Number.isFinite(Number(r.soc_blended)))
      .map((r: any) => ({ t: new Date(Number(r.ts) * 1000).toISOString(), soc: Math.round(Number(r.soc_blended)) }));
    return c.json({ success: true, hours, points });
  } catch (error: any) {
    console.error("history query failed:", error?.message);
    return c.json({ success: false, message: "History is temporarily unavailable" }, 503);
  }
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
dashboard.post("/relay", requireFullAccess, async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: "A JSON body is required" }, 400);
  }

  const validOn = body?.state === 1 || body?.state === true || body?.state === "1";
  const validOff = body?.state === 0 || body?.state === false || body?.state === "0";
  if (!validOn && !validOff) {
    return c.json({ success: false, message: "state must be 0, 1, false, or true" }, 400);
  }
  const next = validOn ? 1 : 0;

  // Take the same lock the cron tick uses, so a manual switch can never race a
  // running auto-shift decision.
  const nowEpoch = Math.floor(Date.now() / 1000);
  const lockExpiresAt = await acquireTickLock(c.env as any, nowEpoch);
  if (lockExpiresAt == null) {
    return c.json({ success: false, message: "The controller is busy; refresh and try again" }, 409);
  }

  try {
    const confirmed = await setTuyaRelayAndConfirm(c.env as any, next === 1);
    await setState(c.env as any, "relay_state", confirmed.relay_on ? "1" : "0");
    await setState(c.env as any, "relay_last_known", confirmed.relay_on ? "1" : "0");
    await setState(c.env as any, "tuya_status", JSON.stringify(confirmed));
    await setState(c.env as any, "relay_command_pending", "");

    // Manual override wins: if auto-shift was mid-cycle and the user just
    // turned WAPDA off, drop the cycle so /api/status stops reporting a phase
    // that is no longer running.
    if (next === 0) {
      try {
        const raw = await getState(c.env as any, "autoshift_state", "");
        const state = normalizeAutoshiftState(raw ? JSON.parse(raw) : null);
        if (state.phase !== "idle") {
          // Stamp last_end_ts so the cooldown applies. Without it the very next
          // cron tick would see a low battery and immediately close the relay
          // again — turning a deliberate manual OFF into a 60-second flap.
          await setState(
            c.env as any,
            "autoshift_state",
            JSON.stringify({ ...normalizeAutoshiftState(null), last_end_ts: Math.floor(Date.now() / 1000) })
          );
          await logEvent(c.env as any, "autoshift", "Auto-shift cycle ended", "Manually overridden from dashboard after relay OFF was confirmed");
        }
      } catch (error: any) {
        console.error("failed to clear auto-shift after manual override:", error?.message);
      }
    }

    await logEvent(
      c.env as any,
      "relay",
      `WAPDA relay ${next ? "closed (ON)" : "opened (OFF)"}`,
      "Manual override confirmed by Tuya read-back"
    );

    return c.json({ success: true, relay_state: next, confirmed: true });
  } catch (e: any) {
    console.error("manual relay command failed:", e?.message);
    return c.json({ success: false, message: "Relay command was not confirmed; the displayed state will be refreshed" }, 502);
  } finally {
    await releaseTickLock(c.env as any, lockExpiresAt).catch(() => {});
  }
});

/* ---------- POST /api/poll ---------- */
dashboard.post("/poll", requireFullAccess, async (c) => {
  try {
    await runSocTick(c.env as any);
  } catch (e: any) {
    console.error("manual poll failed:", e?.message);
    const busy = e?.message === "SOC tick already running";
    return c.json(
      { success: false, message: busy ? "A poll is already running" : "Could not refresh inverter data" },
      busy ? 409 : 502
    );
  }

  await logEvent(
    c.env as any,
    "system",
    "Manual poll requested",
    "Latest device and inverter data fetched successfully"
  );

  const status = await snapshot(c.env as any);
  return c.json({ success: true, polled: true, at: new Date().toISOString(), status });
});

/* ---------- Auto-shift-to-WAPDA settings (voltage-triggered) ---------- */
dashboard.get("/autoshift", async (c) => {
  const env = c.env as any;
  let cfg: AutoshiftConfig = { ...AUTOSHIFT_DEFAULT };
  try {
    const raw = await getState(env, "autoshift_cfg", "");
    cfg = normalizeAutoshiftConfig(raw ? JSON.parse(raw) : cfg);
  } catch {}

  let state = normalizeAutoshiftState(null);
  try {
    const raw = await getState(env, "autoshift_state", "");
    state = normalizeAutoshiftState(raw ? JSON.parse(raw) : null);
  } catch {}

  return c.json({
    success: true,
    enabled: cfg.enabled,
    threshold_v: cfg.threshold_v,
    duration_min: cfg.duration_min,
    pv_stop_w: cfg.pv_stop_w,
    min_on_min: cfg.min_on_min,
    cooldown_min: cfg.cooldown_min,
    window: "18:00–06:00 (Pakistan time) — fixed, not adjustable here",
    phase: state.phase,
    active: state.phase !== "idle",
    charging: state.phase === "charging",
    stopping: state.phase === "stopping",
    stop_reason: state.stop_reason ?? null,
    trigger_voltage: state.trigger_voltage,
    until: state.until_ts ? new Date(state.until_ts * 1000).toISOString() : null,
    min_on_until: state.relay_closed_ts
      ? new Date((state.relay_closed_ts + Math.min(cfg.min_on_min, cfg.duration_min) * 60) * 1000).toISOString()
      : null,
    cooldown_until: state.last_end_ts
      ? new Date((state.last_end_ts + cfg.cooldown_min * 60) * 1000).toISOString()
      : null,
  });
});

dashboard.post("/autoshift", requireFullAccess, async (c) => {
  const env = c.env as any;
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: "A JSON body is required" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ success: false, message: "Invalid settings body" }, 400);
  }

  let cfg: AutoshiftConfig = { ...AUTOSHIFT_DEFAULT };
  try {
    const raw = await getState(env, "autoshift_cfg", "");
    cfg = normalizeAutoshiftConfig(raw ? JSON.parse(raw) : cfg);
  } catch {}

  if (typeof body.enabled === "boolean") cfg.enabled = body.enabled;
  if (body.threshold_v != null) {
    const v = Number(body.threshold_v);
    if (!Number.isFinite(v) || v < 40 || v > 58) return c.json({ success: false, error: "threshold_v must be between 40 and 58 V" }, 400);
    cfg.threshold_v = Math.round(v * 10) / 10;
  }
  if (body.duration_min != null) {
    const m = Number(body.duration_min);
    if (!Number.isInteger(m) || m < 5 || m > 360) return c.json({ success: false, error: "duration_min must be an integer between 5 and 360" }, 400);
    cfg.duration_min = m;
  }
  if (body.pv_stop_w != null) {
    const w = Number(body.pv_stop_w);
    if (!Number.isFinite(w) || w < 50 || w > 2000) return c.json({ success: false, error: "pv_stop_w must be between 50 and 2000 W" }, 400);
    cfg.pv_stop_w = Math.round(w);
  }
  if (body.min_on_min != null) {
    const m = Number(body.min_on_min);
    if (!Number.isInteger(m) || m < 0 || m > 120) return c.json({ success: false, error: "min_on_min must be an integer between 0 and 120" }, 400);
    cfg.min_on_min = m;
  }
  if (body.cooldown_min != null) {
    const m = Number(body.cooldown_min);
    if (!Number.isInteger(m) || m < 0 || m > 240) return c.json({ success: false, error: "cooldown_min must be an integer between 0 and 240" }, 400);
    cfg.cooldown_min = m;
  }

  await setState(env, "autoshift_cfg", JSON.stringify(cfg));

  // Turning the feature off must actually open the relay, not just stop future
  // cycles. If the confirmation can't be obtained right now the cycle is left
  // in "stopping" so the next tick retries.
  let cancellationPending = false;
  if (!cfg.enabled) {
    try {
      const raw = await getState(env, "autoshift_state", "");
      const state = normalizeAutoshiftState(raw ? JSON.parse(raw) : null);
      if (state.phase !== "idle") {
        cancellationPending = true;
        await setState(env, "autoshift_state", JSON.stringify({ ...state, phase: "stopping", until_ts: null, stop_reason: "disabled" }));
        const nowEpoch = Math.floor(Date.now() / 1000);
        const lockExpiresAt = await acquireTickLock(env, nowEpoch);
        if (lockExpiresAt != null) {
          try {
            const confirmed = await setTuyaRelayAndConfirm(env, false);
            await setState(env, "relay_state", "0");
            await setState(env, "relay_last_known", "0");
            await setState(env, "tuya_status", JSON.stringify(confirmed));
            await setState(env, "relay_command_pending", "");
            await setState(env, "autoshift_state", JSON.stringify(normalizeAutoshiftState(null)));
            cancellationPending = false;
          } catch (error: any) {
            console.error("auto-shift disable OFF confirmation failed:", error?.message);
          } finally {
            await releaseTickLock(env, lockExpiresAt).catch(() => {});
          }
        }
      }
    } catch (error: any) {
      console.error("failed to cancel auto-shift:", error?.message);
      cancellationPending = true;
    }
  }

  await logEvent(env, "autoshift", `Auto-shift settings updated`,
    `${cfg.enabled ? "Enabled" : "Disabled"} · trigger ≤ ${cfg.threshold_v} V (18:00–06:00 only) · hold up to ${cfg.duration_min} min · stop early at PV ≥ ${cfg.pv_stop_w} W · relay protection: ${cfg.min_on_min} min minimum ON, ${cfg.cooldown_min} min cooldown`);

  return c.json({ success: true, ...cfg, cancellation_pending: cancellationPending });
});

/* ---------- GET /api/history/cycles (WAPDA billing-cycle history, resets on the 22nd) ---------- */
dashboard.get("/history/cycles", async (c) => {
  const env = c.env as any;
  function cycleStartOf(dateStr: string) {
    const [y, m, d] = dateStr.split("-").map(Number);
    // cycle runs 22nd of a month -> 21st of the next; day>=22 belongs to the cycle starting THIS month
    const cy = d >= 22 ? y : (m === 1 ? y - 1 : y);
    const cm = d >= 22 ? m : (m === 1 ? 12 : m - 1);
    return `${cy}-${String(cm).padStart(2, "0")}-22`;
  }
  function cycleEndOf(cycleStart: string) {
    const [y, m] = cycleStart.split("-").map(Number);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return `${ny}-${String(nm).padStart(2, "0")}-21`;
  }

  try {
    const res: any = await env.zeekay_power_db
      .prepare(`SELECT date, wapda_import_kwh, solar_kwh, charge_kwh, discharge_kwh, pv_peak_w FROM daily_energy_log ORDER BY date ASC`)
      .all();
    const rows = res?.results || [];
    const cycles: Record<string, any> = {};
    for (const r of rows) {
      const key = cycleStartOf(r.date);
      if (!cycles[key]) cycles[key] = { cycle_start: key, cycle_end: cycleEndOf(key), wapda_kwh: 0, solar_kwh: 0, charge_kwh: 0, discharge_kwh: 0, days: 0 };
      cycles[key].wapda_kwh += r.wapda_import_kwh || 0;
      cycles[key].solar_kwh += r.solar_kwh || 0;
      cycles[key].charge_kwh += r.charge_kwh || 0;
      cycles[key].discharge_kwh += r.discharge_kwh || 0;
      cycles[key].days += 1;
    }
    const today = localDayForCycles();
    const currentKey = cycleStartOf(today);
    const list = Object.values(cycles)
      .map((x: any) => ({ ...x, wapda_kwh: r2c(x.wapda_kwh), solar_kwh: r2c(x.solar_kwh), charge_kwh: r2c(x.charge_kwh), discharge_kwh: r2c(x.discharge_kwh), is_current: x.cycle_start === currentKey }))
      .sort((a: any, b: any) => (a.cycle_start < b.cycle_start ? 1 : -1));
    return c.json({ success: true, cycles: list });
  } catch (e: any) {
    console.error("billing-cycle query failed:", e?.message);
    return c.json({ success: false, message: "Billing history is temporarily unavailable" }, 503);
  }
});
function r2c(x: number) { return Math.round(x * 100) / 100; }
function localDayForCycles() { return new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10); }

export default dashboard;
