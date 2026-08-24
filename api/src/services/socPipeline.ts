/*
| SOC + energy pipeline: pull SEMS, run estimator, read Tuya breaker, persist a
| rich live_status for /api/status, log a daily energy row (real inverter
| counters — grid import, charge, discharge) for billing-cycle history, and
| run the voltage-triggered auto-shift-to-WAPDA automation.
| Runs every minute (cron) and on-demand via /api/poll.
*/
import { fetchSemsSnapshot } from "./sems";
import { step, SocState } from "./soc";
import { fetchTuyaStatus, setTuyaRelayAndConfirm, tuyaConfigured, TuyaStatus } from "./tuya";
import {
  getState,
  setState,
  ensureTables,
  logEvent,
  acquireTickLock,
  releaseTickLock,
} from "./dashboardStore";
import {
  AUTOSHIFT_DEFAULT,
  AutoshiftConfig,
  AutoshiftState,
  AutoshiftTransition,
  GridSignals,
  isGridConnected,
  isMainsAvailable,
  isPakistanNightWindow,
  normalizeAutoshiftConfig,
  normalizeAutoshiftState,
  planAutoshift,
} from "./autoshift";
import {
  UnitLockConfig,
  UnitLockState,
  isUnitLockEnforced,
  mayRetryUnitLockOff,
  normalizeUnitLockConfig,
  normalizeUnitLockState,
  planUnitLock,
  reconcileUnitLockAutoshift,
  recordUnitLockOffAttempt,
  recordUnitLockOffConfirmed,
  unitLockWarningKwh,
} from "./unitLock";

const r2 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 100) / 100);
// Pakistan is UTC+5 (no DST) — local calendar day for "today" counters & the billing-cycle grouping.
function localDay(ts_s: number) { return new Date((ts_s + 5 * 3600) * 1000).toISOString().slice(0, 10); }

export async function runSocTick(env: any) {
  await ensureTables(env);

  // Guard against overlapping runs — the 1-minute cron and a manual "Force
  // poll" click can land close together, and without this two concurrent ticks
  // could both decide independently to fire a Tuya relay command.
  const nowEpoch = Math.floor(Date.now() / 1000);
  const lockExpiresAt = await acquireTickLock(env, nowEpoch);
  if (lockExpiresAt == null) throw new Error("SOC tick already running");

  try {
    const snap = await fetchSemsSnapshot(env);
    if (
      snap.v == null || snap.p_chg == null ||
      !Number.isFinite(snap.v) || !Number.isFinite(snap.p_chg) ||
      snap.v < 35 || snap.v > 65
    ) {
      throw new Error("SEMS returned an invalid battery sample");
    }

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
    let tuya: TuyaStatus | null = null;
    let previousTuya: any = null;
    let tuyaReadFailed = false;
    try {
      if (tuyaConfigured(env)) {
        try { const raw = await getState(env, "tuya_status", ""); if (raw) previousTuya = JSON.parse(raw); } catch {}
        tuya = await fetchTuyaStatus(env);

        // The breaker can also be switched from the Tuya app, by a schedule on
        // the device, or by mains cycling. Surface those so a state change that
        // this controller did not cause is never silently invisible.
        if (previousTuya && typeof previousTuya.relay_on === "boolean" && previousTuya.relay_on !== tuya.relay_on) {
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
      semsGridPower: snap.grid_power,
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
    const dt_h = acc.last_ts ? Math.min(600, Math.max(0, snap.ts - acc.last_ts)) / 3600 : 0;
    acc.pv_peak_w = Math.max(acc.pv_peak_w || 0, snap.solar_power || 0);
    const bp = snap.p_chg || 0; // +charge / -discharge (W)
    const wapdaOn = gridConnected;
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

    // --- once-a-day housekeeping so the free-tier D1 never fills up ---
    const lastMaintenanceDay = await getState(env, "last_maintenance_day", "");
    if (lastMaintenanceDay !== today) {
      const historyCutoff = snap.ts - 90 * 24 * 3600;
      await env.zeekay_power_db.batch([
        env.zeekay_power_db.prepare(`DELETE FROM battery_history WHERE ts < ?`).bind(historyCutoff),
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

    // --- auto-shift-to-WAPDA (voltage-triggered; waits for REAL grid, every tick) ---
    let cfg: AutoshiftConfig = { ...AUTOSHIFT_DEFAULT };
    try {
      const raw = await getState(env, "autoshift_cfg", "");
      cfg = normalizeAutoshiftConfig(raw ? JSON.parse(raw) : cfg);
    } catch { cfg = { ...AUTOSHIFT_DEFAULT }; }

    let asState: AutoshiftState = normalizeAutoshiftState(null);
    try {
      const raw = await getState(env, "autoshift_state", "");
      asState = normalizeAutoshiftState(raw ? JSON.parse(raw) : null);
    } catch {}

    // --- WAPDA units lock (Tuya cumulative meter only; no power integration or SEMS) ---
    let unitConfig: UnitLockConfig = normalizeUnitLockConfig(null);
    try {
      const raw = await getState(env, "unit_lock_cfg", "");
      unitConfig = normalizeUnitLockConfig(raw ? JSON.parse(raw) : null);
    } catch {}
    const unitWarningKwh = unitLockWarningKwh(unitConfig.limit_kwh);

    let unitState: UnitLockState = normalizeUnitLockState(null);
    try {
      const raw = await getState(env, "unit_lock_state", "");
      unitState = normalizeUnitLockState(raw ? JSON.parse(raw) : null);
    } catch {}

    // A last-known cumulative Tuya meter is safe as a stationary baseline while
    // the device is temporarily unreachable. No instantaneous power or SEMS
    // counter is accepted by this controller.
    const unitMeterSource = tuya ?? previousTuya;
    const unitPlan = planUnitLock(unitState, {
      nowTs: snap.ts,
      energyTotalKwh: unitMeterSource?.energy_total_kwh ?? null,
    }, unitConfig);
    unitState = unitPlan.state;

    const unitAutoshift = reconcileUnitLockAutoshift(unitState, unitPlan, cfg.enabled);
    unitState = unitAutoshift.state;
    cfg = { ...cfg, enabled: unitAutoshift.enabled };
    if (unitAutoshift.restored_at_release) {
      await logEvent(env, "unit_lock", "Units lock released — auto-shift restored",
        `It is 08:00 Pakistan time. The ${unitConfig.limit_kwh.toFixed(2)} kWh hold is over and auto-shift has been turned back on.`);
    }

    if (unitPlan.warning_reached && !unitPlan.just_locked) {
      await logEvent(env, "unit_lock", `WAPDA units warning: ${unitWarningKwh.toFixed(2)} kWh used`,
        `The 17:00–06:00 Tuya window has used ${unitState.used_kwh.toFixed(2)} kWh. WAPDA will be locked OFF at ${unitConfig.limit_kwh.toFixed(2)} kWh.`);
    }

    if (unitPlan.just_locked) {
      await logEvent(env, "unit_lock", `${unitConfig.limit_kwh.toFixed(2)} kWh limit reached — locking WAPDA OFF`,
        `Tuya measured ${unitState.used_kwh.toFixed(2)} kWh since 17:00. The breaker ${tuya?.relay_on ? "is being opened now" : "is already open"}, and auto-shift will remain disabled until 08:00 Pakistan time.`);
    }

    if (unitAutoshift.settings_changed) {
      if (unitAutoshift.restored_at_release) {
        // At release, turn auto-shift on before clearing restore intent. A
        // crash between writes leaves a retryable restore marker.
        await setState(env, "autoshift_cfg", JSON.stringify(cfg));
        await setState(env, "unit_lock_state", JSON.stringify(unitState));
      } else {
        // At lock, persist restore intent before disabling auto-shift. A crash
        // between writes cannot lose the user's previous ON setting.
        await setState(env, "unit_lock_state", JSON.stringify(unitState));
        await setState(env, "autoshift_cfg", JSON.stringify(cfg));
      }
    }

    if (unitPlan.enforce_off) {
      const autoWasActive = asState.phase !== "idle" || asState.stop_reason !== "unit_limit";
      asState = {
        ...normalizeAutoshiftState(null),
        last_end_ts: asState.last_end_ts ?? snap.ts,
        stop_reason: "unit_limit",
      };
      if (autoWasActive && unitPlan.just_locked) {
        await logEvent(env, "autoshift", "Auto-shift disabled by Units Lock",
          `The ${unitConfig.limit_kwh.toFixed(2)} kWh WAPDA limit outranks battery voltage and all auto-shift settings until 08:00 Pakistan time.`);
      }
      await setState(env, "autoshift_state", JSON.stringify(asState));

      if (tuya?.relay_on && mayRetryUnitLockOff(unitState, snap.ts)) {
        const firstAttempt = unitState.command_attempts === 0;
        unitState = recordUnitLockOffAttempt(unitState, snap.ts);
        try {
          await setState(env, "relay_command_pending", JSON.stringify({
            target: false,
            source: "cloudflare-unit-lock",
            issued_at: snap.ts,
            expires_at: snap.ts + 180,
          }));
          tuya = await setTuyaRelayAndConfirm(env, false);
          unitState = recordUnitLockOffConfirmed(unitState);
          await setState(env, "tuya_status", JSON.stringify(tuya));
          await setState(env, "relay_state", "0");
          await setState(env, "relay_last_known", "0");
          await setState(env, "relay_command_pending", "");
          await logEvent(env, "unit_lock", "Units Lock: WAPDA confirmed OFF",
            "Tuya read-back confirms the breaker is open. It cannot be closed by this dashboard or auto-shift until the 08:00 release.");
        } catch (error: any) {
          console.error("unit-lock relay-off failed:", error?.message);
          if (firstAttempt) {
            await logEvent(env, "alert", "Units Lock could not confirm WAPDA OFF",
              "The controller will keep retrying with relay-safe backoff until Tuya confirms the breaker is open.");
          }
        }
      } else if (tuya && !tuya.relay_on) {
        unitState = recordUnitLockOffConfirmed(unitState);
      }
    }

    await setState(env, "unit_lock_state", JSON.stringify(unitState));

    // A unit-lock OFF command may have changed the physical state. Rebuild the
    // grid signals before any auto-shift decision or live-status write.
    gridSignals = {
      relayOn: !!tuya?.relay_on,
      tuyaOnline: tuya?.online ?? null,
      semsGridPower: snap.grid_power,
      tuyaGridPower: tuya?.grid_power ?? null,
      tuyaGridVoltage: tuya?.grid_voltage ?? null,
    };
    mainsAvailable = isMainsAvailable(gridSignals);
    gridConnected = isGridConnected(gridSignals);

    const localHour = new Date((snap.ts + 5 * 3600) * 1000).getUTCHours();
    const inNightWindow = isPakistanNightWindow(snap.ts);
    const pvNow = snap.solar_power ?? 0;

    if (tuya && !unitPlan.enforce_off) {
      const previousState = asState;
      const planInput = {
        nowTs: snap.ts,
        batteryVoltage: snap.v,
        pvPower: pvNow,
        inNightWindow,
        gridConnected,
        relayOn: !!tuya.relay_on,
      };
      const plan = planAutoshift(cfg, asState, planInput);
      asState = plan.state;
      const transitions: AutoshiftTransition[] = plan.transition ? [plan.transition] : [];
      let commandError: string | null = null;

      if (plan.command) {
        try {
          const target = plan.command === "on";
          await setState(env, "relay_command_pending", JSON.stringify({
            target,
            source: "cloudflare-autoshift",
            issued_at: snap.ts,
            expires_at: snap.ts + 180,
          }));
          tuya = await setTuyaRelayAndConfirm(env, target);
          await setState(env, "tuya_status", JSON.stringify(tuya));
          await setState(env, "relay_state", tuya.relay_on ? "1" : "0");
          await setState(env, "relay_last_known", tuya.relay_on ? "1" : "0");
          await setState(env, "relay_command_pending", "");

          // Re-plan against the CONFIRMED post-command reading so the stored
          // phase reflects what the hardware actually did this tick.
          const confirmedSignals: GridSignals = {
            ...gridSignals,
            relayOn: !!tuya.relay_on,
            tuyaOnline: tuya.online ?? null,
            tuyaGridPower: tuya.grid_power ?? null,
            tuyaGridVoltage: tuya.grid_voltage ?? null,
          };
          mainsAvailable = isMainsAvailable(confirmedSignals);
          gridConnected = isGridConnected(confirmedSignals);
          const confirmedPlan = planAutoshift(cfg, asState, {
            ...planInput,
            relayOn: !!tuya.relay_on,
            gridConnected: isGridConnected(confirmedSignals),
          });
          asState = confirmedPlan.state;
          if (confirmedPlan.transition) transitions.push(confirmedPlan.transition);
        } catch (error: any) {
          commandError = error?.message || String(error);
          console.error(`autoshift relay-${plan.command} failed:`, commandError);
        }
      }

      // Resolve the reason AFTER the confirmed re-plan — reading it too early
      // used to mislabel every window/PV stop as "Auto-shift was disabled".
      const requestedStopReason =
        asState.stop_reason ?? plan.state.stop_reason ?? previousState.stop_reason ?? null;

      if (transitions.includes("started_waiting")) {
        await logEvent(env, "autoshift", "Auto-shift: watching for WAPDA",
          `Battery at ${snap.v.toFixed(1)} V (≤ ${cfg.threshold_v} V, ${localHour}:00 local) — relay ON requested; true grid-side telemetry is required before the ${cfg.duration_min}-min timer starts`);
      }
      if (transitions.includes("grid_confirmed")) {
        await logEvent(env, "autoshift", "Auto-shift: WAPDA confirmed — charging now",
          `Grid confirmed with breaker closed (${Math.round(snap.grid_power ?? 0)} W SEMS, ${Math.round(tuya.grid_voltage ?? 0)} V Tuya) — charging for up to ${cfg.duration_min} min or until PV ≥ ${cfg.pv_stop_w} W`);
      }
      if (transitions.includes("grid_lost")) {
        await logEvent(env, "autoshift", "Auto-shift: WAPDA lost again",
          "Grid-side telemetry disappeared mid-charge — the timer is paused and the breaker is left as-is while the controller waits for confirmed mains");
      }
      if (transitions.includes("external_override")) {
        await logEvent(env, "autoshift", "Auto-shift: cycle ended — breaker opened elsewhere",
          `The WAPDA breaker was closed by this controller and then opened by something else (Tuya app schedule, a manual switch, or mains cycling a breaker whose power-on state is OFF). The cycle has ended rather than closing the relay again; a new one can start after the ${cfg.cooldown_min}-min cooldown.`);
      }
      if (transitions.includes("stop_requested")) {
        const reason =
          requestedStopReason === "pv_recovered" ? `PV reached ${Math.round(pvNow)} W (≥ ${cfg.pv_stop_w} W)`
          : requestedStopReason === "duration_complete" ? `${cfg.duration_min} min of confirmed WAPDA charging finished`
          : requestedStopReason === "window_ended" ? "The 18:00–06:00 automation window ended"
          : requestedStopReason === "external_override" ? "The breaker was opened outside this controller"
          : "Auto-shift was switched off";
        await logEvent(env, "autoshift", "Auto-shift: turning WAPDA OFF", `${reason} — waiting for relay read-back confirmation`);
      }
      if (transitions.includes("stopped") && !transitions.includes("external_override")) {
        await logEvent(env, "autoshift", "Auto-shift: WAPDA confirmed OFF",
          `Relay read-back is open; cycle ended (${requestedStopReason || "cancelled"})`);
      }
      if (commandError && (transitions.length > 0 || previousState.phase !== asState.phase)) {
        await logEvent(env, "alert", "Auto-shift relay command failed",
          `The controller remains in ${asState.phase} and will retry safely on the next poll`);
      }

      await setState(env, "autoshift_state", JSON.stringify(asState));
    }

    const charging = bp > 20;
    const wapdaPowerW = tuya?.grid_power ?? (
      tuya?.grid_voltage != null && tuya?.grid_current != null
        ? tuya.grid_voltage * tuya.grid_current
        : null
    );
    const tuyaOnlySignals: GridSignals = {
      relayOn: !!tuya?.relay_on,
      tuyaOnline: tuya?.online ?? null,
      tuyaGridPower: tuya?.grid_power ?? null,
      tuyaGridVoltage: tuya?.grid_voltage ?? null,
    };
    const wapdaAvailable = tuya ? isMainsAvailable(tuyaOnlySignals) : false;
    const wapdaActive = tuya ? isGridConnected(tuyaOnlySignals) : false;
    const unitLockEnforced = isUnitLockEnforced(unitState, snap.ts, unitConfig.enabled);
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
      wapda_today_kwh: r2(snap.wapda_today_kwh),
      meter_total_kwh: r2(snap.meter_total_kwh),
      // Kept for API compatibility, but explicitly represents inverter output
      // voltage. It must never be used as proof that WAPDA is present.
      ac_voltage: r2(snap.output_voltage),
      // energy today (real counters; solar/WAPDA split estimated by ratio)
      charge_from_solar_kwh: r2(chargeFromSolarKwh),
      charge_from_wapda_kwh: r2(chargeFromWapdaKwh),
      total_charge_kwh: r2(realChargeKwh),
      discharge_today_kwh: r2(realDischargeKwh),
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
      autoshift_charging: asState.phase === "charging",
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
    } catch (error: any) {
      console.error("failed to release SOC tick lock:", error?.message);
    }
  }
}
