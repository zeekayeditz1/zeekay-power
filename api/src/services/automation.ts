import type { SemsSnapshot } from "./sems";
import { getState, setState, logEvent } from "./dashboardStore";
import { setTuyaRelayAndConfirm, TuyaStatus } from "./tuya";
import { AUTOSHIFT_DEFAULT, AutoshiftConfig, AutoshiftState, AutoshiftTransition, GridSignals, normalizeAutoshiftConfig, normalizeAutoshiftState, isMainsAvailable, isGridConnected, isPakistanNightWindow, planAutoshift } from "./autoshift";
import { UnitLockConfig, UnitLockState, normalizeUnitLockConfig, normalizeUnitLockState, unitLockWarningKwh, planUnitLock, reconcileUnitLockAutoshift, mayRetryUnitLockOff, recordUnitLockOffAttempt, recordUnitLockOffConfirmed } from "./unitLock";

// Always called with the shared controller lock held. Tuya limit enforcement
// and owned-cycle shutdown do not depend on the inverter API being available.
export async function runAutomationTick(env:any, reading:TuyaStatus|null, now:number, battery:SemsSnapshot|null=null) {
  let tuya=reading;
  const snap=battery??{v:Infinity,p_chg:null,solar_power:null,grid_power:null};
  let gridSignals:GridSignals={relayOn:!!tuya?.relay_on,tuyaOnline:tuya?.online??null,tuyaGridPower:tuya?.grid_power??null,tuyaGridVoltage:tuya?.grid_voltage??null};
  let mainsAvailable=isMainsAvailable(gridSignals),gridConnected=isGridConnected(gridSignals);
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

    // Offline cached meter values cannot advance the night limit.
    const unitMeterSource = tuya?.online ? tuya : null;
    const unitPlan = planUnitLock(unitState, {
      nowTs: now,
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
        last_end_ts: asState.last_end_ts ?? now,
        stop_reason: "unit_limit",
      };
      if (autoWasActive && unitPlan.just_locked) {
        await logEvent(env, "autoshift", "Auto-shift disabled by Units Lock",
          `The ${unitConfig.limit_kwh.toFixed(2)} kWh WAPDA limit outranks battery voltage and all auto-shift settings until 08:00 Pakistan time.`);
      }
      await setState(env, "autoshift_state", JSON.stringify(asState));

      if (tuya?.online && tuya.relay_on && mayRetryUnitLockOff(unitState, now)) {
        const firstAttempt = unitState.command_attempts === 0;
        unitState = recordUnitLockOffAttempt(unitState, now);
        try {
          await setState(env, "relay_command_pending", JSON.stringify({
            target: false,
            source: "cloudflare-unit-lock",
            issued_at: now,
            expires_at: now + 180,
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
      } else if (tuya?.online && !tuya.relay_on) {
        unitState = recordUnitLockOffConfirmed(unitState);
      }
    }

    await setState(env, "unit_lock_state", JSON.stringify(unitState));

    // A unit-lock OFF command may have changed the physical state. Rebuild the
    // grid signals before any auto-shift decision or live-status write.
    gridSignals = {
      relayOn: !!tuya?.relay_on,
      tuyaOnline: tuya?.online ?? null,
      // WAPDA decisions use only live mains-side telemetry.
      tuyaGridPower: tuya?.grid_power ?? null,
      tuyaGridVoltage: tuya?.grid_voltage ?? null,
    };
    mainsAvailable = isMainsAvailable(gridSignals);
    gridConnected = isGridConnected(gridSignals);

    const localHour = new Date((now + 5 * 3600) * 1000).getUTCHours();
    const inNightWindow = isPakistanNightWindow(now);
    const pvNow = snap.solar_power ?? 0;

    if (!unitPlan.enforce_off) {
      const previousState = asState;
      const planInput = {
        nowTs: now,
        batteryVoltage: snap.v ?? Infinity,
        pvPower: pvNow,
        inNightWindow,
        gridConnected,
        relayOn: !!tuya?.relay_on,
        relayKnown: tuya?.online === true,
        batteryCharging: battery?.p_chg!=null ? battery.p_chg > 20 : null,
      };
      const plan = planAutoshift(cfg, asState, planInput);
      asState = plan.state;
      const transitions: AutoshiftTransition[] = plan.transition ? [plan.transition] : [];
      let commandError: string | null = null;

      if (plan.command && tuya?.online) {
        try {
          const target = plan.command === "on";
          await setState(env, "relay_command_pending", JSON.stringify({
            target,
            source: "cloudflare-autoshift",
            issued_at: now,
            expires_at: now + 180,
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
            relayOn: !!tuya?.relay_on,
            tuyaOnline: tuya.online ?? null,
            tuyaGridPower: tuya.grid_power ?? null,
            tuyaGridVoltage: tuya.grid_voltage ?? null,
          };
          mainsAvailable = isMainsAvailable(confirmedSignals);
          gridConnected = isGridConnected(confirmedSignals);
          const confirmedPlan = planAutoshift(cfg, asState, {
            ...planInput,
            relayOn: !!tuya?.relay_on,
            relayKnown: tuya?.online === true,
            batteryCharging: battery?.p_chg!=null ? battery.p_chg > 20 : null,
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
          `Battery at ${(snap.v??0).toFixed(1)} V (≤ ${cfg.threshold_v} V, ${localHour}:00 local) — relay ON requested; true grid-side telemetry is required before the ${cfg.duration_min}-min timer starts`);
      }
      if (transitions.includes("grid_confirmed")) {
        await logEvent(env, "autoshift", "Auto-shift: WAPDA confirmed — charging now",
          `Grid confirmed with breaker closed (${Math.round(snap.grid_power ?? 0)} W SEMS, ${Math.round(tuya?.grid_voltage ?? 0)} V Tuya) — charging for up to ${cfg.duration_min} min or until PV ≥ ${cfg.pv_stop_w} W`);
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

  return {tuya,cfg,asState,unitConfig,unitState,unitPlan,mainsAvailable,gridConnected};
}
