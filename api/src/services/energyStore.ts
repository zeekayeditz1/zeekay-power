import { runAutomationTick } from "./automation";
import { BATTERY_MAX_SAMPLE_GAP_S } from "./telemetry";
import { getState, setState, acquireTickLock, releaseTickLock, ensureTables } from "./dashboardStore";
import { BatteryEnergySample, buildDischargeHistory, dischargeInterval, dischargeWindow, localEnergyDate, meterInterval, MeterEnergySample, DAY_S, billingCycleStart, billingCycleEnd } from "./energy";
import { TuyaStatus, fetchTuyaStatus, fetchTuyaEnergyDay, fetchTuyaEnergyCapabilities, tuyaConfigured } from "./tuya";

// Called under the controller lock so tracker state and bucket increments
// can be committed atomically, without replaying the same sample after a crash.
export async function recordDischargeSample(env:any,sample:BatteryEnergySample) {
  const raw=await getState(env,"discharge_energy_tracker","");
  if(!raw) {
    // Recover the last seven completed 5PM days plus the current day from the
    // retained signed battery history, rather than waiting a week for the UI.
    const since=dischargeWindow(sample.ts).start-7*DAY_S;
    const rows:any=await env.zeekay_power_db.prepare(`SELECT ts,p FROM battery_history WHERE ts>=? AND ts<=? ORDER BY ts`).bind(since-180,sample.ts).all();
    const days=buildDischargeHistory(rows.results??[]).filter(day=>day.window_start>=since);
    const writes=days.map(day=>env.zeekay_power_db.prepare(
      `INSERT INTO discharge_daily_energy (window_start,date,kwh,covered_s) VALUES (?,?,?,?)
       ON CONFLICT(window_start) DO UPDATE SET kwh=excluded.kwh,covered_s=excluded.covered_s`
    ).bind(day.window_start,day.date,day.kwh,day.covered_s));
    writes.push(trackerWrite(env,"discharge_energy_tracker",sample));
    await env.zeekay_power_db.batch(writes);
    return;
  }
  const previous:BatteryEnergySample=JSON.parse(raw);
  if(sample.ts<=previous.ts) return;
  const writes=dischargeInterval(previous,sample).map(delta=>env.zeekay_power_db.prepare(
    `INSERT INTO discharge_daily_energy (window_start,date,kwh,covered_s) VALUES (?,?,?,?)
     ON CONFLICT(window_start) DO UPDATE SET kwh=discharge_daily_energy.kwh+excluded.kwh,
     covered_s=discharge_daily_energy.covered_s+excluded.covered_s`
  ).bind(delta.window_start,delta.date,delta.kwh,delta.covered_s));
  writes.push(trackerWrite(env,"discharge_energy_tracker",sample));
  await env.zeekay_power_db.batch(writes);
}

export async function wapdaEnergyDays(env:any) {
  const rows:any=await env.zeekay_power_db.prepare(`SELECT *,
    CASE WHEN reported_kwh IS NOT NULL THEN
      CASE WHEN reported_at >= (unixepoch(date||'T00:00:00Z')+86400-18000)
        THEN MAX(observed_kwh,reported_kwh)
        ELSE MAX(observed_kwh,reported_kwh+MAX(0,observed_kwh-reported_observed_kwh)) END
      ELSE observed_kwh END AS kwh
    FROM wapda_daily_energy ORDER BY date`).all();
  return rows.results??[];
}
export async function billingCycles(env:any,now:number) {
  const solar:any=await env.zeekay_power_db.prepare(`SELECT date,solar_kwh,charge_kwh,discharge_kwh FROM daily_energy_log ORDER BY date`).all();
  const wapda=await wapdaEnergyDays(env);
  const today=localEnergyDate(now), current=billingCycleStart(today);
  const cycles=new Map<string,any>();
  function cycle(date:string) {
    const start=billingCycleStart(date);
    if(!cycles.has(start)) cycles.set(start,{cycle_start:start,cycle_end:billingCycleEnd(start),is_current:start===current,
      solar_kwh:0,charge_kwh:0,discharge_kwh:0,days:0,wapda_kwh:null,wapda_days:0,wapda_reported_days:0,wapda_partial:false,wapda_first_date:null,wapda_source:"tuya_only"});
    return cycles.get(start);
  }
  cycle(today);
  for(const day of solar.results??[]) {
    const c=cycle(day.date); c.solar_kwh+=day.solar_kwh??0; c.charge_kwh+=day.charge_kwh??0; c.discharge_kwh+=day.discharge_kwh??0; c.days++;
  }
  for(const day of wapda) {
    const c=cycle(day.date); c.wapda_kwh=(c.wapda_kwh??0)+day.kwh; c.wapda_days++;
    if(day.reported_kwh!=null) c.wapda_reported_days++; else if(day.partial) c.wapda_partial=true;
    c.wapda_first_date??=day.date;
  }
  return [...cycles.values()].map(c=>{
    const end=c.is_current?today:c.cycle_end;
    const expected=Math.round((Date.parse(end+"T00:00:00Z")-Date.parse(c.cycle_start+"T00:00:00Z"))/86400000)+1;
    c.wapda_missing_days=Math.max(0,expected-c.wapda_days);
    c.wapda_partial=c.wapda_partial||c.wapda_missing_days>0;
    for(const key of ["solar_kwh","charge_kwh","discharge_kwh","wapda_kwh"]) if(c[key]!=null) c[key]=Math.round(c[key]*100)/100;
    return c;
  }).sort((a,b)=>b.cycle_start.localeCompare(a.cycle_start));
}
function trackerWrite(env:any,key:string,value:any) {
  return env.zeekay_power_db.prepare(`INSERT INTO app_state (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(key,JSON.stringify(value));
}

export async function dischargeDays(env:any,now:number,days=7) {
  const current=dischargeWindow(now);
  const rows:any=await env.zeekay_power_db.prepare(`SELECT * FROM discharge_daily_energy WHERE window_start>=? AND window_start<=? ORDER BY window_start DESC`)
    .bind(current.start-days*DAY_S,current.start).all();
  const map=new Map<number,any>((rows.results??[]).map((r:any)=>[r.window_start,r]));
  const history=[];
  for(let i=0;i<=days;i++) {
    const start=current.start-i*DAY_S, row=map.get(start);
    const elapsed=Math.max(0,Math.min(DAY_S,now-start));
    const coverage=row&&elapsed>0 ? Math.min(100,row.covered_s/elapsed*100) : 0;
    history.push({date:dischargeWindow(start).date,window_start:new Date(start*1000).toISOString(),window_end:new Date((start+DAY_S)*1000).toISOString(),
      discharge_kwh:row?Math.round(row.kwh*1000)/1000:null,coverage_pct:Math.round(coverage*10)/10,
      partial:!row||elapsed-row.covered_s>(i===0?BATTERY_MAX_SAMPLE_GAP_S:180),is_current:i===0,source:"battery_dc_discharge_only"});
  }
  return history;
}

export async function recordWapdaSample(env:any,tuya:TuyaStatus,ts:number) {
  const writes=[env.zeekay_power_db.prepare(`INSERT OR IGNORE INTO wapda_meter_samples (ts,total_kwh,voltage,current,power,online) VALUES (?,?,?,?,?,?)`)
    .bind(ts,tuya.energy_total_kwh,tuya.grid_voltage,tuya.grid_current,tuya.grid_power,tuya.online?1:0)];
  if(tuya.online&&tuya.energy_total_kwh!=null&&Number.isFinite(tuya.energy_total_kwh)&&tuya.energy_total_kwh>=0) {
    const sample:MeterEnergySample={ts,kwh:tuya.energy_total_kwh};
    const raw=await getState(env,"wapda_energy_tracker","");
    const previous:MeterEnergySample|null=raw?JSON.parse(raw):null;
    if(previous&&ts<=previous.ts) return;
    const deltas=previous?meterInterval(previous,sample):[{date:localEnergyDate(ts),kwh:0,partial:true}];
    for(const delta of deltas) writes.push(env.zeekay_power_db.prepare(
      `INSERT INTO wapda_daily_energy (date,observed_kwh,partial,first_ts,last_ts) VALUES (?,?,?,?,?)
       ON CONFLICT(date) DO UPDATE SET observed_kwh=wapda_daily_energy.observed_kwh+excluded.observed_kwh,
       partial=MAX(wapda_daily_energy.partial,excluded.partial),last_ts=MAX(wapda_daily_energy.last_ts,excluded.last_ts)`
    ).bind(delta.date,delta.kwh,delta.partial?1:0,previous?.ts??ts,ts));
    writes.push(trackerWrite(env,"wapda_energy_tracker",sample));
  }
  await env.zeekay_power_db.batch(writes);
}

// Used if SEMS is unavailable: WAPDA metering must continue on its own.
export async function runWapdaEnergyTick(env:any) {
  await ensureTables(env);
  if(!tuyaConfigured(env)) return;
  let tuya:TuyaStatus|null=null;
  try { tuya=await fetchTuyaStatus(env); } catch {}
  const now=Math.floor(Date.now()/1000), lock=await acquireTickLock(env,now,180);
  if(lock==null) return;
  try {
    if(tuya) await recordWapdaSample(env,tuya,now);
    const controls=await runAutomationTick(env,tuya,now);
    tuya=controls.tuya;
    if(tuya) await setState(env,"tuya_status",JSON.stringify(tuya));
    await setState(env,"tuya_reachable",tuya?"1":"0");
  } finally { await releaseTickLock(env,lock); }
}

// Recover authoritative kWh/day from Tuya's energy API. Six dates per cron
// keeps request/CPU use bounded; network work never holds the relay lock.
export async function syncTuyaEnergyHistory(env:any) {
  await ensureTables(env);
  if(!tuyaConfigured(env)) return;
  const now=Math.floor(Date.now()/1000), today=localEnergyDate(now);
  const lastAttempt=Number(await getState(env,"tuya_energy_sync_attempt","0"));
  const previousStatus=JSON.parse(await getState(env,"tuya_energy_sync_status","{}"));
  if(now-lastAttempt<(previousStatus.status==="unavailable"?300:45)) return;
  await setState(env,"tuya_energy_sync_attempt",String(now));
  const start=localEnergyDate(now-90*DAY_S);
  const rows:any=await env.zeekay_power_db.prepare(`SELECT date,reported_at FROM wapda_daily_energy WHERE date>=? AND date<=?`).bind(start,today).all();
  const known=new Map<string,number>((rows.results??[]).map((r:any)=>[r.date,Number(r.reported_at??0)]));
  const dates:string[]=[];
  for(let date=start;date<today;date=new Date(Date.parse(date+"T00:00:00Z")+DAY_S*1000).toISOString().slice(0,10)) {
    const reportedAt=known.get(date)??0;
    const dayEnd=Date.parse(date+"T00:00:00Z")/1000+DAY_S-5*3600;
    // A report fetched during its day is provisional. Fetch it once again
    // after midnight so the closing minutes are not lost forever.
    if(!reportedAt || reportedAt<dayEnd) dates.push(date);
  }
  // Closed days only: reports cannot race live increments from today.
  dates.sort((a,b)=>b.localeCompare(a));
  for(const date of dates.slice(0,6)) {
    try {
      const baseline:any=await env.zeekay_power_db.prepare(`SELECT observed_kwh FROM wapda_daily_energy WHERE date=?`).bind(date).first();
      const kwh=await fetchTuyaEnergyDay(env,date);
      await env.zeekay_power_db.prepare(`INSERT INTO wapda_daily_energy (date,reported_kwh,reported_at) VALUES (?,?,?)
        ON CONFLICT(date) DO UPDATE SET reported_kwh=excluded.reported_kwh,reported_at=excluded.reported_at,
        reported_observed_kwh=?`)
        .bind(date,kwh,now,baseline?.observed_kwh??0).run();
      await setState(env,"tuya_energy_sync_status",JSON.stringify({status:"ok",last_success:now,last_date:date}));
    } catch(error:any) {
      await setState(env,"tuya_energy_sync_status",JSON.stringify({status:"unavailable",last_attempt:now,message:error?.message??"Tuya energy history unavailable"}));
      if(!await getState(env,"tuya_energy_capabilities","")) {
        try { await setState(env,"tuya_energy_capabilities",JSON.stringify(await fetchTuyaEnergyCapabilities(env))); } catch {}
      }
      break;
    }
  }
}
