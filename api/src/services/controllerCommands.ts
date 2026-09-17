import { acquireTickLock, releaseTickLock, getState, setState, logEvent } from "./dashboardStore";
import { normalizeUnitLockConfig, normalizeUnitLockState, planUnitLock, reconcileUnitLockAutoshift, isUnitLockEnforced, unitLockWindow, unitLockWarningKwh } from "./unitLock";
import { normalizeAutoshiftConfig, normalizeAutoshiftState } from "./autoshift";
import { setTuyaRelayAndConfirm } from "./tuya";

export type CommandKind = "unit-lock" | "relay" | "autoshift";
export interface ControllerCommand {
  id: string; kind: CommandKind; payload: string; status: string;
  created_ts: number; result: string | null;
}

async function readJson(env: any, key: string) {
  const raw = await getState(env, key, "");
  return raw ? JSON.parse(raw) : null;
}

// Called only while holding the controller lock. Configuration and state stay
// serialized with automation, including a disable followed by a manual ON.
async function applyUnitLockSettings(env: any, body: any) {
  const now = Math.floor(Date.now() / 1000);
  const previous = normalizeUnitLockConfig(await readJson(env, "unit_lock_cfg"));
  const config = normalizeUnitLockConfig({ ...previous, ...body });
  let state = normalizeUnitLockState(await readJson(env, "unit_lock_state"));
  let restored = false;
  if (!config.enabled) await setState(env, "unit_lock_cfg", JSON.stringify(config));
  if (!config.enabled || !previous.enabled) {
    const plan = planUnitLock(state, { nowTs: now, energyTotalKwh: null }, { ...config, enabled: false });
    let auto = normalizeAutoshiftConfig(await readJson(env, "autoshift_cfg"));
    const reconciled = reconcileUnitLockAutoshift(plan.state, plan, auto.enabled);
    state = reconciled.state;
    restored = reconciled.restored_at_release;
    if (reconciled.settings_changed) {
      auto = { ...auto, enabled: reconciled.enabled };
      await setState(env, "autoshift_cfg", JSON.stringify(auto));
    }
    // Clear pending unit-limit stopping state so it cannot undo manual ON.
    const autoState = normalizeAutoshiftState(await readJson(env, "autoshift_state"));
    if (autoState.stop_reason === "unit_limit") {
      await setState(env, "autoshift_state", JSON.stringify({ ...normalizeAutoshiftState(null), last_end_ts: now }));
    }
    await setState(env, "unit_lock_state", JSON.stringify(state));
  }
  if (config.enabled) await setState(env, "unit_lock_cfg", JSON.stringify(config));
  const locked = isUnitLockEnforced(state, now, config.enabled);
  const willLock = config.enabled && !locked && unitLockWindow(now).active && state.used_kwh >= config.limit_kwh;
  await logEvent(env, "unit_lock", `Units Lock ${config.enabled ? "settings saved" : "turned OFF"}`,
    config.enabled ? `Limit: ${config.limit_kwh.toFixed(2)} kWh; only the Tuya cumulative meter is counted.` : "Tracking and enforcement disabled; manual WAPDA control is available. Re-enabling starts a fresh meter baseline.");
  return { success: true, ...config, locked, will_lock_next_tick: willLock,
    warning_kwh: unitLockWarningKwh(config.limit_kwh), used_kwh: state.used_kwh,
    autoshift_restored: restored, source: "tuya_forward_energy_total_only", applies_within_seconds: 60 };
}

async function applyAutoshiftSettings(env:any,body:any) {
  const now=Math.floor(Date.now()/1000);
  const unitConfig=normalizeUnitLockConfig(await readJson(env,"unit_lock_cfg"));
  const unit=normalizeUnitLockState(await readJson(env,"unit_lock_state"));
  if(body.enabled===true && isUnitLockEnforced(unit,now,unitConfig.enabled)) return {success:false,code:"UNIT_LOCK_ACTIVE",message:"Disable Units Lock first",http_status:423};
  if(typeof body.enabled==="boolean") await setState(env,"unit_lock_state",JSON.stringify({...unit,restore_autoshift_on_unlock:false}));
  const cfg=normalizeAutoshiftConfig({...normalizeAutoshiftConfig(await readJson(env,"autoshift_cfg")),...body});
  await setState(env,"autoshift_cfg",JSON.stringify(cfg));
  let pending=false;
  const state=normalizeAutoshiftState(await readJson(env,"autoshift_state"));
  if(!cfg.enabled && state.phase!=="idle") {
    pending=true;
    await setState(env,"autoshift_state",JSON.stringify({...state,phase:"stopping",stop_reason:"disabled",until_ts:null}));
    try {
      const confirmed=await setTuyaRelayAndConfirm(env,false);
      await setState(env,"tuya_status",JSON.stringify(confirmed));
      await setState(env,"relay_state","0"); await setState(env,"relay_last_known","0");
      await setState(env,"autoshift_state",JSON.stringify({...normalizeAutoshiftState(null),last_end_ts:now}));
      pending=false;
    } catch {}
  }
  await logEvent(env,"autoshift","Auto-shift settings saved",cfg.enabled?"Enabled":"Disabled");
  return {success:true,...cfg,cancellation_pending:pending};
}

async function applyRelay(env: any, body: any) {
  const now = Math.floor(Date.now() / 1000);
  const on = body.state === 1;
  // Recheck AFTER obtaining the lock, not against a pre-lock snapshot.
  const config = normalizeUnitLockConfig(await readJson(env, "unit_lock_cfg"));
  const unit = normalizeUnitLockState(await readJson(env, "unit_lock_state"));
  if (on && isUnitLockEnforced(unit, now, config.enabled)) {
    return { success: false, code: "UNIT_LOCK_ACTIVE", message: "Disable Units Lock before switching WAPDA ON", http_status: 423 };
  }
  const confirmed = await setTuyaRelayAndConfirm(env, on);
  await setState(env, "relay_state", confirmed.relay_on ? "1" : "0");
  await setState(env, "relay_last_known", confirmed.relay_on ? "1" : "0");
  await setState(env, "tuya_status", JSON.stringify(confirmed));
  await setState(env, "relay_command_pending", "");
  // A manual command takes ownership from any active auto-shift cycle. Its
  // previously scheduled stop must never switch an emergency manual ON off.
  const auto = normalizeAutoshiftState(await readJson(env, "autoshift_state"));
  if (auto.phase !== "idle") {
    await setState(env, "autoshift_state", JSON.stringify({ ...normalizeAutoshiftState(null), last_end_ts: now }));
    await logEvent(env, "autoshift", "Auto-shift cycle ended", "Manual relay command confirmed; cycle ownership released");
  }
  await logEvent(env, "relay", `WAPDA relay ${on ? "closed (ON)" : "opened (OFF)"}`, "Manual override confirmed by online Tuya read-back");
  return { success: true, relay_state: on ? 1 : 0, confirmed: true };
}

export async function enqueueControllerCommand(env: any, kind: CommandKind, payload: any) {
  const id = crypto.randomUUID();
  await env.zeekay_power_db.prepare(
    `INSERT INTO controller_commands (id,kind,payload,status,created_ts) VALUES (?,?,?,'queued',?)`
  ).bind(id, kind, JSON.stringify(payload), Math.floor(Date.now() / 1000)).run();
  return id;
}

export async function getControllerCommand(env: any, id: string) {
  const row = await env.zeekay_power_db.prepare(`SELECT * FROM controller_commands WHERE id = ?`).bind(id).first() as ControllerCommand | null;
  if (!row) return null;
  return { command_id: id, status: row.status, queued: row.status === "queued" || row.status === "running",
    ...(row.result ? JSON.parse(row.result) : { success: true }) };
}

export async function processControllerCommands(env: any) {
  const now = Math.floor(Date.now() / 1000);
  const lock = await acquireTickLock(env, now, 180);
  if (lock == null) return;
  try {
    // Never replay a command interrupted after it may have touched hardware.
    await env.zeekay_power_db.prepare(`UPDATE controller_commands SET status='failed', result=? WHERE status='running'`)
      .bind(JSON.stringify({ success: false, message: "Controller interrupted; check the physical relay state before retrying" })).run();
    const row = await env.zeekay_power_db.prepare(`SELECT * FROM controller_commands WHERE status='queued' ORDER BY rowid LIMIT 1`).first() as ControllerCommand | null;
    if (!row) return;
    let result: any;
    if (now - row.created_ts > 180) {
      result = { success: false, message: "Request expired without running; please try again", http_status: 408 };
    } else {
      await env.zeekay_power_db.prepare(`UPDATE controller_commands SET status='running' WHERE id=?`).bind(row.id).run();
      try {
        const payload = JSON.parse(row.payload);
        result = row.kind === "unit-lock" ? await applyUnitLockSettings(env, payload) : row.kind === "autoshift" ? await applyAutoshiftSettings(env,payload) : await applyRelay(env, payload);
      } catch {
        result = { success: false, message: "Controller command could not be confirmed; refresh status before retrying", http_status: 502 };
      }
    }
    await env.zeekay_power_db.prepare(`UPDATE controller_commands SET status=?,result=? WHERE id=?`)
      .bind(result.success ? "completed" : "failed", JSON.stringify(result), row.id).run();
    await env.zeekay_power_db.prepare(`DELETE FROM controller_commands WHERE created_ts < ? AND status IN ('completed','failed')`).bind(now - 86400).run();
  } finally {
    await releaseTickLock(env, lock);
  }
}

// Bounded background wait: the durable queue also drains on each cron and
// after polling releases its lock, so an API request can return immediately.
export async function waitForControllerCommand(env: any, id: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await processControllerCommands(env);
    const command = await getControllerCommand(env, id);
    if (!command?.queued) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
