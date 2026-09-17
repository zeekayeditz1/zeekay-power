import {describe,it,expect} from "vitest";
import {hardwareSampleTime} from "../../src/services/sems";

describe("SEMS hardware sample timestamps",()=>{
  it("interprets the installation's local device time in Pakistan",()=>{
    expect(hardwareSampleTime({}, {last_time:"2026-09-17 20:00:00"})).toBe(Date.parse("2026-09-17T20:00:00+05:00")/1000);
  });
  it("preserves explicit timezone and device epoch timestamps",()=>{
    const ts=Date.parse("2026-09-17T15:00:00Z")/1000;
    expect(hardwareSampleTime({last_time:"2026-09-17T15:00:00Z"},{})).toBe(ts);
    expect(hardwareSampleTime({last_time:ts*1000},{})).toBe(ts);
  });
  it("cannot substitute a server response time for a missing device timestamp",()=>{
    expect(hardwareSampleTime({server_time:"2026-09-17 20:00:00"},{})).toBeNull();
    expect(hardwareSampleTime({}, {last_time:"unavailable"})).toBeNull();
  });
});
