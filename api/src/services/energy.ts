import { BATTERY_MAX_SAMPLE_GAP_S } from "./telemetry";
export const DAY_S = 86400;
export const PKT_S = 5 * 3600;
export const MAX_DISCHARGE_GAP_S = BATTERY_MAX_SAMPLE_GAP_S;
export function localEnergyDate(ts: number) { return new Date((ts + PKT_S) * 1000).toISOString().slice(0, 10); }
export function dischargeWindow(ts: number) {
  const start = Math.floor((ts - 12 * 3600) / DAY_S) * DAY_S + 12 * 3600;
  return { start, end: start + DAY_S, date: localEnergyDate(start) };
}
export function billingCycleStart(date: string) {
  const [y,m,d]=date.split("-").map(Number);
  const value=new Date(Date.UTC(y,m-1-(d<22?1:0),22));
  return value.toISOString().slice(0,10);
}
export function billingCycleEnd(start: string) {
  const [y,m]=start.split("-").map(Number);
  return new Date(Date.UTC(y,m,21)).toISOString().slice(0,10);
}
export interface BatteryEnergySample { ts:number; p:number; }
export interface DischargeBucket { window_start:number; date:string; kwh:number; covered_s:number; }

// Integrate the negative part of the SIGNED DC power. If a minute changes
// from discharge to charge, split at zero rather than netting the two flows.
function negativePowerArea(a:number,b:number,seconds:number) {
  if(a>=0 && b>=0) return 0;
  if(a<=0 && b<=0) return -(a+b)/2*seconds;
  const fraction=Math.abs(a)/(Math.abs(a)+Math.abs(b));
  return a<0 ? -a/2*seconds*fraction : -b/2*seconds*(1-fraction);
}
export function dischargeInterval(a:BatteryEnergySample,b:BatteryEnergySample):DischargeBucket[] {
  const dt=b.ts-a.ts;
  if(!Number.isFinite(a.p)||!Number.isFinite(b.p)||!Number.isFinite(dt)||dt<=0||dt>MAX_DISCHARGE_GAP_S) return [];
  const result:DischargeBucket[]=[];
  let cursor=a.ts;
  while(cursor<b.ts) {
    const window=dischargeWindow(cursor);
    const end=Math.min(b.ts,window.end);
    const power=(ts:number)=>a.p+(b.p-a.p)*(ts-a.ts)/dt;
    result.push({window_start:window.start,date:window.date,
      kwh:negativePowerArea(power(cursor),power(end),end-cursor)/3600000,covered_s:end-cursor});
    cursor=end;
  }
  return result;
}
export function buildDischargeHistory(samples:BatteryEnergySample[]) {
  const days=new Map<number,DischargeBucket>();
  for(let i=1;i<samples.length;i++) for(const delta of dischargeInterval(samples[i-1],samples[i])) {
    const day=days.get(delta.window_start)??{...delta,kwh:0,covered_s:0};
    day.kwh+=delta.kwh; day.covered_s+=delta.covered_s; days.set(day.window_start,day);
  }
  return [...days.values()].sort((a,b)=>a.window_start-b.window_start);
}

export interface MeterEnergySample { ts:number; kwh:number; }
export interface MeterDelta { date:string; kwh:number; partial:boolean; }
export function meterInterval(a:MeterEnergySample,b:MeterEnergySample):MeterDelta[] {
  if(!Number.isFinite(a.kwh)||!Number.isFinite(b.kwh)||a.kwh<0||b.kwh<0||b.ts<=a.ts) return [];
  // A falling meter is a reset/replacement. Establish a new baseline; do not
  // silently invent the unmeasured energy around the reset.
  if(b.kwh<a.kwh) return [{date:localEnergyDate(b.ts),kwh:0,partial:true}];
  const delta=b.kwh-a.kwh, dt=b.ts-a.ts;
  const days:MeterDelta[]=[];
  let cursor=a.ts;
  while(cursor<b.ts) {
    const midnight=Math.floor((cursor+PKT_S)/DAY_S)*DAY_S-PKT_S;
    const end=Math.min(b.ts,midnight+DAY_S);
    days.push({date:localEnergyDate(cursor),kwh:delta*(end-cursor)/dt,partial:dt>180 || localEnergyDate(a.ts)!==localEnergyDate(b.ts)});
    cursor=end;
  }
  return days;
}
