import { describe, expect, it } from "vitest";
import { step, referenceRuntimeMinutes, DEFAULTS, SocState } from "../../src/services/soc";
import { isMainsAvailable, isGridConnected } from "../../src/services/autoshift";

describe("measured battery profile and SOC", () => {
  it("uses the recorded knee instead of extending the early linear slope", () => {
    expect(referenceRuntimeMinutes(48.5)).toBe(520);
    expect(referenceRuntimeMinutes(47.7)).toBe(340);
    expect(referenceRuntimeMinutes(47.3)).toBe(275);
    expect(referenceRuntimeMinutes(46.5)).toBe(135);
    expect(referenceRuntimeMinutes(45)).toBe(0);
    expect(referenceRuntimeMinutes(46)).toBe(90);
    expect(DEFAULTS.c_usable_ah).toBe(140);
  });
  it("does not treat the start of the overnight test as fully charged", () => {
    const out=step({}, {v:48.5,p_chg:-318.25,ts:1000,bms_soc:99});
    expect(out.blended).toBeLessThan(70);
    expect(out.anchored).toBe(false);
    expect(out.runtime_confidence).toBe("low");
  });
  it("shortens runtime for heavier battery draw", () => {
    const light=step({}, {v:46.5,p_chg:-318.25,ts:1000});
    const heavy=step({}, {v:46.5,p_chg:-636.5,ts:1000});
    expect(light.runtime_min).toBeCloseTo(135);
    expect(heavy.runtime_min!).toBeLessThan(light.runtime_min!/2);
  });
  it("does not refill SOC from charging voltage or duplicate timestamps", () => {
    const initial:SocState={soc:40,last_ts:1000,c_usable_ah:140,_prev:{v:48,i:0}};
    const charged=step(initial,{v:58,p_chg:580,ts:1060});
    expect(charged.blended!).toBeLessThan(40.2);
    expect(step(charged,{v:58,p_chg:580,ts:1060})).toEqual(charged);
    expect(step(charged,{v:58,p_chg:580,ts:1050})).toEqual(charged);
  });
  it("does not integrate a telemetry gap or anchor it as rest", () => {
    const initial=step({}, {v:48,p_chg:0,ts:1000});
    const out=step(initial,{v:48,p_chg:0,ts:10000});
    expect(out.soc_cc).toBe(initial.soc_cc);
    expect(out.anchored).toBe(false);
    expect(out.rest_run_s).toBe(0);
  });
  it("keeps usable reserve empty after cutoff voltage rebounds", () => {
    let s=step({}, {v:45,p_chg:-300,ts:1000});
    expect(s.usable_soc).toBe(0);
    s=step(s,{v:48,p_chg:0,ts:1060});
    expect(s.usable_soc).toBe(0);
    s=step(s,{v:48,p_chg:240,ts:1120});
    expect(s.cutoff_latched).toBe(false);
    expect(s.runtime_min).toBeNull();
  });
  it("does not increase estimated SOC from load-removal rebound while discharging", () => {
    const initial=step({}, {v:46,p_chg:-500,ts:1000});
    const out=step(initial,{v:48,p_chg:-100,ts:1060});
    expect(out.blended!).toBeLessThanOrEqual(initial.blended!);
  });
  it("learns positive resistance using the charging-positive current convention", () => {
    const initial=step({}, {v:48,p_chg:-240,ts:1000});
    const out=step(initial,{v:47.5,p_chg:-475,ts:1060});
    expect(out.ri_ohm!).toBeGreaterThan(initial.ri_ohm!);
  });
});

describe("mains evidence", () => {
  it("ignores cached voltage and power when Tuya is offline or unverified", () => {
    for(const online of [false,null]) {
      const s={relayOn:true,tuyaOnline:online,tuyaGridVoltage:230,tuyaGridPower:900};
      expect(isMainsAvailable(s)).toBe(false);
      expect(isGridConnected(s)).toBe(false);
    }
  });
  it("distinguishes an open relay from an upstream outage", () => {
    const available={relayOn:false,tuyaOnline:true,tuyaGridVoltage:230};
    expect(isMainsAvailable(available)).toBe(true);
    expect(isGridConnected(available)).toBe(false);
    expect(isMainsAvailable({...available,tuyaGridVoltage:0})).toBe(false);
  });
});
