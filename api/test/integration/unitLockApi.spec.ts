import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createToken } from "../../src/utils/jwt";

const ORIGIN = "https://zeekay-power.test";
const TEST_SECRET = "test-only-secret-not-used-in-production";

async function authHeaders() {
  const token = await createToken(
    { id: "test-user", name: "Test User", email: "test@example.invalid" },
    TEST_SECRET,
  );
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("Units Lock API", () => {
  it("serves the Worker health endpoint", async () => {
    const response = await exports.default.fetch(new Request(`${ORIGIN}/api/health`));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, status: "online" });
  });

  it("saves and reads an editable limit through authenticated routes", async () => {
    const headers = await authHeaders();
    const save = await exports.default.fetch(new Request(`${ORIGIN}/api/unit-lock`, {
      method: "POST",
      headers,
      body: JSON.stringify({ limit_kwh: 4.5 }),
    }));
    expect(save.status).toBe(200);
    await expect(save.json()).resolves.toMatchObject({
      success: true,
      enabled: true,
      limit_kwh: 4.5,
      warning_kwh: 3.6,
    });

    const read = await exports.default.fetch(new Request(`${ORIGIN}/api/unit-lock`, { headers }));
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      success: true,
      enabled: true,
      limit_kwh: 4.5,
      min_kwh: 0.1,
      max_kwh: 50,
      source: "tuya_forward_energy_total_only",
    });
  });

  it("turns Units Lock off and on independently from its saved limit", async () => {
    const headers = await authHeaders();
    const disable = await exports.default.fetch(new Request(`${ORIGIN}/api/unit-lock`, {
      method: "POST",
      headers,
      body: JSON.stringify({ enabled: false }),
    }));
    expect(disable.status).toBe(200);
    await expect(disable.json()).resolves.toMatchObject({
      success: true,
      enabled: false,
      locked: false,
      source: "tuya_forward_energy_total_only",
    });

    const readDisabled = await exports.default.fetch(new Request(`${ORIGIN}/api/unit-lock`, { headers }));
    await expect(readDisabled.json()).resolves.toMatchObject({ enabled: false, locked: false });

    const enable = await exports.default.fetch(new Request(`${ORIGIN}/api/unit-lock`, {
      method: "POST",
      headers,
      body: JSON.stringify({ enabled: true }),
    }));
    expect(enable.status).toBe(200);
    await expect(enable.json()).resolves.toMatchObject({ success: true, enabled: true });
  });

  it("rejects unsafe values and unauthenticated changes", async () => {
    const headers = await authHeaders();
    const invalid = await exports.default.fetch(new Request(`${ORIGIN}/api/unit-lock`, {
      method: "POST",
      headers,
      body: JSON.stringify({ limit_kwh: 0 }),
    }));
    expect(invalid.status).toBe(400);

    const unauthorized = await exports.default.fetch(new Request(`${ORIGIN}/api/unit-lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit_kwh: 6 }),
    }));
    expect(unauthorized.status).toBe(401);
  });
});
