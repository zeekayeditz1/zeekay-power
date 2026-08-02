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

  // --- auto-shift-to-WAPDA (voltage-triggered; waits for REAL grid, every tick) ---
  let cfg = { ...AUTOSHIFT_DEFAULT };
  try { const raw = await getState(env, "autoshift_cfg", ""); if (raw) cfg = { ...cfg, ...JSON.parse(raw) }; } catch {}
  // phase: "idle" (not needed) -> "waiting_for_grid" (relay closed, WAPDA not
  // yet confirmed present, rechecked every tick) -> "charging" (WAPDA
  // confirmed, real duration countdown running) -> back to "idle" when done.
  let asState: any = { phase: "idle", trigger_ts: null, trigger_voltage: null, charge_start_ts: null, until_ts: null };
  try {
    const raw = await getState(env, "autoshift_state", "");
    if (raw) {
      const parsed = JSON.parse(raw);
      // migrate the old {active:boolean} shape from before this redesign
      asState = parsed.phase ? { ...asState, ...parsed } : {
        phase: parsed.active ? "charging" : "idle",
        trigger_ts: parsed.trigger_ts ?? null, trigger_voltage: parsed.trigger_voltage ?? null,
        charge_start_ts: parsed.trigger_ts ?? null, until_ts: parsed.until_ts ?? null,
      };
    }
  } catch {}

  // Fixed nighttime trigger window: 18:00 (6 PM) through 05:59 (just before 6 AM), Pakistan local time.
  const localHour = new Date((snap.ts + 5 * 3600) * 1000).getUTCHours();
  const inNightWindow = localHour >= 18 || localHour < 6;
  const pvNow = snap.solar_power ?? 0;
  // "Grid confirmed" means the inverter itself reports real AC/power on the
  // line — not just "the relay reports closed", which proves nothing if the
  // grid line upstream has no power at all.
  const gridConfirmed = (snap.grid_power ?? 0) > 20 || (snap.ac_voltage ?? 0) > 50;
  const prevPhase = asState.phase;

  if (cfg.enabled && tuya) {
    const nowTs = snap.ts;

    if (asState.phase === "idle") {
      if (inNightWindow && snap.v <= cfg.threshold_v && !tuya.relay_on) {
        asState = { phase: "waiting_for_grid", trigger_ts: nowTs, trigger_voltage: snap.v, charge_start_ts: null, until_ts: null };
        try { await setTuyaRelay(env, true); } catch (e: any) { console.error("autoshift relay-on attempt failed:", e?.message); }
      }
    } else if (asState.phase === "waiting_for_grid") {
      // Re-assert the relay closed every tick — cheap, and self-heals if an
      // earlier command silently failed — and check every tick for REAL grid.
      // The instant WAPDA is actually confirmed present, a full charge window
      // starts from THIS moment, not from whenever the relay first closed.
      try { await setTuyaRelay(env, true); } catch (e: any) { console.error("autoshift relay-on retry failed:", e?.message); }
      if (gridConfirmed) {
        asState = { ...asState, phase: "charging", charge_start_ts: nowTs, until_ts: nowTs + cfg.duration_min * 60 };
      } else if (pvNow >= cfg.pv_stop_w) {
        try { await setTuyaRelay(env, false); } catch (e: any) { console.error("autoshift cancel failed:", e?.message); }
        asState = { phase: "idle", trigger_ts: null, trigger_voltage: null, charge_start_ts: null, until_ts: null };
      }
    } else if (asState.phase === "charging") {
      if (pvNow >= cfg.pv_stop_w) {
        try { await setTuyaRelay(env, false); } catch (e: any) { console.error("autoshift OFF (pv) failed:", e?.message); }
        asState = { phase: "idle", trigger_ts: null, trigger_voltage: null, charge_start_ts: null, until_ts: null };
      } else if (!gridConfirmed) {
        // WAPDA dropped out again mid-hold (e.g. load-shedding resumed) — go
        // back to watching every tick instead of abandoning the whole cycle;
        // the relay stays closed so it's ready the instant grid returns.
        asState = { ...asState, phase: "waiting_for_grid", until_ts: null };
      } else if (nowTs >= (asState.until_ts || 0)) {
        try { await setTuyaRelay(env, false); } catch (e: any) { console.error("autoshift OFF failed:", e?.message); }
        asState = { phase: "idle", trigger_ts: null, trigger_voltage: null, charge_start_ts: null, until_ts: null };
      }
    }

    // Log only on an actual phase TRANSITION, never every tick — a long wait
    // for WAPDA can span hours and must not spam Recent Events.
    if (asState.phase !== prevPhase) {
      if (prevPhase === "idle" && asState.phase === "waiting_for_grid") {
        await logEvent(env, "autoshift", "Auto-shift: watching for WAPDA",
          `Battery at ${snap.v.toFixed(1)} V (\u2264 ${cfg.threshold_v} V, ${localHour}:00 local) \u2014 relay closed, rechecking every minute for real grid power before starting a ${cfg.duration_min}-min charge`);
      } else if (prevPhase === "waiting_for_grid" && asState.phase === "charging") {
        await logEvent(env, "autoshift", "Auto-shift: WAPDA confirmed \u2014 charging now",
          `Grid power detected (${Math.round(snap.grid_power ?? 0)} W, ${Math.round(snap.ac_voltage ?? 0)} V) \u2014 charging for up to ${cfg.duration_min} min or until PV \u2265 ${cfg.pv_stop_w} W`);
      } else if (prevPhase === "charging" && asState.phase === "waiting_for_grid") {
        await logEvent(env, "autoshift", "Auto-shift: WAPDA lost again",
          "Grid power dropped mid-charge \u2014 relay stays closed, watching every minute for it to return");
      } else if (prevPhase === "charging" && asState.phase === "idle") {
        const reason = pvNow >= cfg.pv_stop_w
          ? `PV reached ${Math.round(pvNow)} W (\u2265 ${cfg.pv_stop_w} W) \u2014 ended early`
          : `${cfg.duration_min} min of confirmed WAPDA charging finished`;
        await logEvent(env, "autoshift", "Auto-shift: WAPDA turned OFF", reason);
      } else if (prevPhase === "waiting_for_grid" && asState.phase === "idle") {
        await logEvent(env, "autoshift", "Auto-shift: cancelled",
          `PV reached ${Math.round(pvNow)} W before WAPDA ever returned \u2014 no longer needed, relay opened`);
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
    autoshift_phase: asState.phase,
    autoshift_active: asState.phase !== "idle",
    autoshift_charging: asState.phase === "charging",
    autoshift_until: asState.until_ts ? new Date(asState.until_ts * 1000).toISOString() : null,
    autoshift_trigger_voltage: asState.trigger_voltage ?? null,
    updated_at: new Date().toISOString(),
  };
  await setState(env, "live_status", JSON.stringify(status));
  return status;
}
