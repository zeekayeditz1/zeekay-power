import { env,exports } from "cloudflare:workers";
import { beforeAll,beforeEach,describe,it,expect } from "vitest";
import { ensureTables,getState } from "../../src/services/dashboardStore";
import { recordDischargeSample,recordWapdaSample,dischargeDays,billingCycles } from "../../src/services/energyStore";
import { createToken } from "../../src/utils/jwt";
const e:any=env;
const ts=(value:string)=>Date.parse(value)/1000;
beforeAll(()=>ensureTables(e));
beforeEach(async()=>{
  await e.zeekay_power_db.batch(["discharge_daily_energy","wapda_daily_energy","wapda_meter_samples","battery_history","daily_energy_log","app_state"].map(table=>e.zeekay_power_db.prepare(`DELETE FROM ${table}`)));
});
describe("persisted daily energy",()=>{
  it("recovers old battery history and adds only new discharge once",async()=>{
    const start=ts("2026-09-16T20:00:00+05:00");
    await e.zeekay_power_db.batch([{ts:start,p:-600},{ts:start+60,p:-600}].map(s=>e.zeekay_power_db.prepare("INSERT INTO battery_history (ts,p) VALUES (?,?)").bind(s.ts,s.p)));
    await recordDischargeSample(e,{ts:start+60,p:-600});
    await recordDischargeSample(e,{ts:start+120,p:600});
    await recordDischargeSample(e,{ts:start+120,p:600});
    const days=await dischargeDays(e,start+120,7);
    expect(days).toHaveLength(8);
    expect(days[0].discharge_kwh).toBe(0.013);
    expect(days[1].discharge_kwh).toBeNull();
    expect(days[0].partial).toBe(true);
  });
  it("ignores cached offline meter increments and counts the recovered online delta",async()=>{
    const start=ts("2026-09-16T20:00:00+05:00");
    const meter:any={online:true,energy_total_kwh:100,grid_voltage:230,grid_current:4,grid_power:850};
    await recordWapdaSample(e,meter,start);
    await recordWapdaSample(e,{...meter,online:false,energy_total_kwh:500,grid_voltage:null,grid_current:null,grid_power:null},start+60);
    await recordWapdaSample(e,{...meter,energy_total_kwh:101},start+120);
    await recordWapdaSample(e,{...meter,energy_total_kwh:101},start+120);
    const cycle=(await billingCycles(e,start+120))[0];
    expect(cycle.wapda_kwh).toBe(1);
    expect(cycle.wapda_partial).toBe(true);
    expect(JSON.parse(await getState(e,"wapda_energy_tracker","{}")).kwh).toBe(101);
  });
  it("does not reuse the erroneous inverter WAPDA total and preserves solar",async()=>{
    await e.zeekay_power_db.prepare("INSERT INTO daily_energy_log (date,wapda_import_kwh,solar_kwh) VALUES ('2026-09-16',45.6,12)").run();
    const cycle=(await billingCycles(e,ts("2026-09-16T20:00:00+05:00")))[0];
    expect(cycle.solar_kwh).toBe(12);
    expect(cycle.wapda_kwh).toBeNull();
    expect(cycle.wapda_partial).toBe(true);
  });
  it("adds meter increments after a reported total without counting them twice",async()=>{
    await e.zeekay_power_db.prepare("INSERT INTO wapda_daily_energy (date,reported_kwh,observed_kwh,reported_observed_kwh,reported_at) VALUES ('2026-09-16',7,2,1,1)").run();
    const cycle=(await billingCycles(e,ts("2026-09-16T20:00:00+05:00")))[0];
    expect(cycle.wapda_kwh).toBe(8);
  });
  it("serves seven completed days and the current day through an authenticated API",async()=>{
    const token=await createToken({id:"test",name:"Test",email:"test@example.invalid"},"test-only-secret-not-used-in-production");
    const response=await exports.default.fetch(new Request("https://zeekay-power.test/api/history/discharge?days=7",{headers:{Authorization:`Bearer ${token}`}}));
    expect(response.status).toBe(200);
    const result:any=await response.json();
    expect(result.day_starts_at).toBe("17:00");
    expect(result.history).toHaveLength(8);
    expect(result.history.filter((r:any)=>r.is_current)).toHaveLength(1);
  });
});
