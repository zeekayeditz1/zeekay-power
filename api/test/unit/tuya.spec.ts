import { describe, it, expect, vi, afterEach } from "vitest";

/*
| Guards the one thing in the Tuya client that the whole relay state machine
| rests on: deciding whether the breaker is actually closed.
*/

vi.mock("../../src/services/dashboardStore", () => ({
  getState: vi.fn(async () => JSON.stringify({ token: "cached", exp: Date.now() + 600000 })),
  setState: vi.fn(async () => {}),
}));

import { fetchTuyaStatus } from "../../src/services/tuya";

const ENV: any = {
  TUYA_CLIENT_ID: "cid",
  TUYA_CLIENT_SECRET: "secret",
  TUYA_DEVICE_ID: "dev",
  TUYA_REGION: "eu",
};

function mockStatus(dps: Record<string, any>) {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(
      JSON.stringify({ success: true, result: Object.entries(dps).map(([code, value]) => ({ code, value })) }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  ));
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchTuyaStatus relay state", () => {
  it("uses the switch DP, not the power-on-behaviour setting", async () => {
    // Exactly what the live breaker returns while it is CLOSED and passing
    // 4.5 A: switch=true but relay_status="power_off".
    mockStatus({ switch: true, relay_status: "power_off", phase_a: "B/YAABGZAAA1" });
    const s = await fetchTuyaStatus(ENV);
    expect(s.relay_on).toBe(true);
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
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ success: true, result: null }), { status: 200 })
    ));
    await expect(fetchTuyaStatus(ENV)).rejects.toThrow(/invalid result/);
  });
});
