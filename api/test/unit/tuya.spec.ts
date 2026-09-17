import { describe, it, expect, vi, afterEach } from "vitest";

/*
| Guards the one thing in the Tuya client that the whole relay state machine
| rests on: deciding whether the breaker is actually closed.
*/

vi.mock("../../src/services/dashboardStore", () => ({
  getState: vi.fn(async () => JSON.stringify({ token: "cached", exp: Date.now() + 600000 })),
  setState: vi.fn(async () => {}),
}));

import { fetchTuyaStatus,fetchTuyaEnergyDay } from "../../src/services/tuya";

const ENV: any = {
  TUYA_CLIENT_ID: "cid",
  TUYA_CLIENT_SECRET: "secret",
  TUYA_DEVICE_ID: "dev",
  TUYA_REGION: "eu",
};

function mockStatus(dps: Record<string, any>, online=true) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    new Response(
      JSON.stringify({ success: true, result: url.endsWith("/status") ? Object.entries(dps).map(([code, value]) => ({ code, value })) : { online } }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  ));
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchTuyaStatus relay state", () => {
  it("signs energy history with sorted query keys and accepts only numeric kWh",async()=>{
    const request=vi.fn(async()=>new Response(JSON.stringify({success:true,result:6.25})));
    vi.stubGlobal("fetch",request);
    expect(await fetchTuyaEnergyDay(ENV,"2026-08-22")).toBe(6.25);
    expect(request.mock.calls[0][0]).toBe("https://openapi.tuyaeu.com/v1.0/iot-03/energy/electricity/device/nodes/statistics-sum?containChilds=false&device_ids=dev&endTime=20260822&energy_action=consume&startTime=20260822&statisticsType=day");
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({success:true,result:"6.25"}))));
    await expect(fetchTuyaEnergyDay(ENV,"2026-08-22")).rejects.toThrow(/invalid kWh/);
  });
  it("uses the switch DP, not the power-on-behaviour setting", async () => {
    // Exactly what the live breaker returns while it is CLOSED and passing
    // 4.5 A: switch=true but relay_status="power_off".
    mockStatus({ switch: true, relay_status: "power_off", phase_a: "B/YAABGZAAA1" });
    const s = await fetchTuyaStatus(ENV);
    expect(s.relay_on).toBe(true);
    expect(s.grid_voltage).toBeCloseTo(203.8);
    expect(s.grid_current).toBeCloseTo(4.505);
    expect(s.grid_power).toBe(53);
  });

  it("reports OPEN when the switch is off even if power-on behaviour is 'power_on'", async () => {
    // The old logic OR-ed relay_status === "power_on" in, so flipping this
    // setting in the Tuya app would have pinned relay_on to true forever.
    mockStatus({ switch: false, relay_status: "power_on" });
    const s = await fetchTuyaStatus(ENV);
    expect(s.relay_on).toBe(false);
  });

  it("falls back to relay_status only when there is no switch DP", async () => {
    mockStatus({ relay_status: "power_on" });
    expect((await fetchTuyaStatus(ENV)).relay_on).toBe(true);
    mockStatus({ relay_status: "power_off" });
    expect((await fetchTuyaStatus(ENV)).relay_on).toBe(false);
  });

  it("rejects a malformed status payload instead of guessing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      new Response(JSON.stringify({ success: true, result: url.endsWith("/status") ? null : { online:true } }), { status: 200 })
    ));
    await expect(fetchTuyaStatus(ENV)).rejects.toThrow(/invalid result/);
  });

  it("also decodes the 8-byte phase format without shifting current or power",async()=>{
    const phase=Buffer.from([0x09,0x06,0x00,0x11,0x94,0x00,0x04,0x0b]).toString("base64");
    mockStatus({switch:true,phase_a:phase,forward_energy_total:30320});
    const s=await fetchTuyaStatus(ENV);
    expect(s.grid_voltage).toBe(231);
    expect(s.grid_current).toBeCloseTo(4.5);
    expect(s.grid_power).toBe(1035);
    expect(s.energy_total_kwh).toBe(303.2);
  });

  it("discards cached voltage and power when the device is offline", async () => {
    mockStatus({ switch: true, phase_a: "B/YAABGZAAA1", supply_frequency:500 },false);
    const s=await fetchTuyaStatus(ENV);
    expect(s.online).toBe(false);
    expect(s.grid_voltage).toBeNull();
    expect(s.grid_power).toBeNull();
    expect(s.frequency_hz).toBeNull();
  });
});
