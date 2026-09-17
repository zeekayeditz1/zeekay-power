import { describe,it,expect } from "vitest";
import { dischargeWindow, dischargeInterval, buildDischargeHistory, meterInterval, billingCycleStart, billingCycleEnd } from "../../src/services/energy";
const ts=(value:string)=>Date.parse(value)/1000;

describe("battery discharge only, 5PM Pakistan day",()=>{
  it("rolls over exactly at 17:00, with a 24-hour window across month and year boundaries",()=>{
    const before=dischargeWindow(ts("2026-01-01T16:59:59+05:00"));
    const after=dischargeWindow(ts("2026-01-01T17:00:00+05:00"));
    expect(before.date).toBe("2025-12-31");
    expect(after.date).toBe("2026-01-01");
    expect(after.end-after.start).toBe(86400);
    expect(after.start).toBe(before.end);
  });
  it("counts constant discharge and completely excludes constant charging",()=>{
    const start=ts("2026-09-16T20:00:00+05:00");
    expect(dischargeInterval({ts:start,p:-600},{ts:start+60,p:-600})[0].kwh).toBeCloseTo(0.01);
    expect(dischargeInterval({ts:start,p:600},{ts:start+60,p:600})[0].kwh).toBe(0);
  });
  it("integrates one normal hardware upload interval without counting duplicate polls",()=>{
    const a={ts:1000,p:-600};
    expect(dischargeInterval(a,{ts:1600,p:-600})[0].kwh).toBeCloseTo(.1);
    expect(dischargeInterval(a,a)).toEqual([]);
  });
  it("does not cancel discharge against charging during a zero crossing",()=>{
    const start=ts("2026-09-16T20:00:00+05:00");
    expect(dischargeInterval({ts:start,p:-600},{ts:start+60,p:600})[0].kwh).toBeCloseTo(0.0025);
    expect(dischargeInterval({ts:start,p:600},{ts:start+60,p:-600})[0].kwh).toBeCloseTo(0.0025);
  });
  it("splits a measured interval at 5PM without losing or duplicating energy",()=>{
    const start=ts("2026-09-16T16:59:30+05:00");
    const buckets=dischargeInterval({ts:start,p:-600},{ts:start+60,p:-600});
    expect(buckets).toHaveLength(2);
    expect(buckets.map(x=>x.date)).toEqual(["2026-09-15","2026-09-16"]);
    expect(buckets.map(x=>x.kwh)).toEqual([0.005,0.005]);
  });
  it("keeps both sides of midnight in the same discharge day",()=>{
    const start=ts("2026-09-16T23:59:00+05:00");
    const buckets=dischargeInterval({ts:start,p:-600},{ts:start+120,p:-600});
    expect(buckets).toHaveLength(1);
    expect(buckets[0].date).toBe("2026-09-16");
    expect(buckets[0].kwh).toBeCloseTo(0.02);
  });
  it("does not invent energy in gaps, duplicates, reversed timestamps or invalid power",()=>{
    const a={ts:1000,p:-600};
    for(const b of [{ts:1901,p:-600},{ts:1000,p:-600},{ts:999,p:-600},{ts:1060,p:NaN}]) expect(dischargeInterval(a,b)).toEqual([]);
  });
  it("rebuilds a discharge-only history from retained signed power",()=>{
    const start=ts("2026-09-16T20:00:00+05:00");
    const history=buildDischargeHistory([{ts:start,p:-600},{ts:start+60,p:-600},{ts:start+120,p:600},{ts:start+180,p:600}]);
    expect(history[0].kwh).toBeCloseTo(0.0125);
    expect(history[0].covered_s).toBe(180);
  });
});
describe("Tuya counter energy and billing",()=>{
  it("uses counter differences regardless of battery charge or solar",()=>{
    const start=ts("2026-09-16T20:00:00+05:00");
    expect(meterInterval({ts:start,kwh:100},{ts:start+60,kwh:100.12})[0].kwh).toBeCloseTo(0.12);
  });
  it("marks a reset without fabricating extra consumption",()=>{
    const start=ts("2026-09-16T20:00:00+05:00");
    expect(meterInterval({ts:start,kwh:303},{ts:start+60,kwh:1})).toEqual([{date:"2026-09-16",kwh:0,partial:true}]);
  });
  it("recovers cumulative usage across an outage, while marking uncertain daily attribution",()=>{
    const start=ts("2026-09-16T23:00:00+05:00");
    const buckets=meterInterval({ts:start,kwh:100},{ts:start+7200,kwh:102});
    expect(buckets.reduce((sum,b)=>sum+b.kwh,0)).toBeCloseTo(2);
    expect(buckets.every(b=>b.partial)).toBe(true);
  });
  it("starts the confirmed billing cycle on 22 August and handles December rollover",()=>{
    expect(billingCycleStart("2026-09-17")).toBe("2026-08-22");
    expect(billingCycleStart("2026-09-22")).toBe("2026-09-22");
    expect(billingCycleStart("2026-01-01")).toBe("2025-12-22");
    expect(billingCycleEnd("2025-12-22")).toBe("2026-01-21");
  });
});
