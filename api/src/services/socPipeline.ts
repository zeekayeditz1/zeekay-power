/*
| SOC pipeline: pull one live SEMS reading, run the hybrid estimator, persist
| state + latest status (for /api/status) + a history row (for /api/history).
| Called by the 1-minute cron (scheduled) and by POST /api/poll.
*/
import { fetchSemsSnapshot } from "./sems";
import { step, SocState } from "./soc";
import { getState, setState, ensureTables } from "./dashboardStore";
import { fetchTuyaStatus, tuyaConfigured } from "./tuya";

const r2 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 100) / 100);

export async function runSocTick(env: any) {
  await ensureTables(env);
  const snap = await fetchSemsSnapshot(env);
  if (snap.v == null || snap.p_chg == null) throw new Error("bad SEMS sample");

  let prev: SocState = {};
  try { const raw = await getState(env, "soc_state", ""); if (raw) prev = JSON.parse(raw); } catch {}

  const out = step(prev, { v: snap.v, p_chg: snap.p_chg, ts: snap.ts, bms_soc: snap.bms_soc });
  out.bms_soc = snap.bms_soc;
  await setState(env, "soc_state", JSON.stringify(out));

  const status = {
    battery_soc: Math.round(out.blended ?? 0),
    soc_voltage: r2(out.soc_v),
    soc_coulomb: r2(out.soc_cc),
    bms_soc: snap.bms_soc,
    battery_voltage: snap.v,
    battery_power: r2(snap.p_chg),
    solar_power: snap.solar_power ?? 0,
    load_power: snap.load_power ?? 0,
    grid_power: snap.grid_power ?? 0,
    ac_voltage: snap.ac_voltage ?? 0,
    energy_today: snap.energy_today ?? null,
    anchored: !!out.anchored,
    usable_capacity_ah: r2(out.c_usable_ah),
    updated_at: new Date().toISOString(),
  };
  await setState(env, "live_status", JSON.stringify(status));

  await env.zeekay_power_db
    .prepare(
      `INSERT OR REPLACE INTO battery_history (ts,v,p,soc_blended,soc_v,soc_cc,bms_soc,anchored)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .bind(snap.ts, snap.v, snap.p_chg, r2(out.blended), r2(out.soc_v), r2(out.soc_cc), snap.bms_soc, out.anchored ? 1 : 0)
    .run();

  // Best-effort Tuya read (never breaks the SOC pipeline)
  try {
    if (tuyaConfigured(env)) {
      const tuya = await fetchTuyaStatus(env);
      await setState(env, "tuya_status", JSON.stringify(tuya));
    }
  } catch (e: any) { console.error("tuya read:", e?.message); }

  return status;
}
