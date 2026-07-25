export interface Env {
  SEMS_EMAIL: string;
  SEMS_PASSWORD: string;
}

function ensureConfig(env: Env) {
  if (!env.SEMS_EMAIL || !env.SEMS_PASSWORD) {
    throw new Error("SEMS_EMAIL and SEMS_PASSWORD must be set in environment");
  }
}

/**
 * Build a Basic Authorization header value from the configured SEMS credentials.
 */
export function buildBasicAuthHeader(env: Env): string {
  ensureConfig(env);

  const creds = `${env.SEMS_EMAIL}:${env.SEMS_PASSWORD}`;
  const token = typeof Buffer !== "undefined"
    ? Buffer.from(creds).toString("base64")
    : btoa(creds);

  return `Basic ${token}`;
}

/**
 * Minimal fetch wrapper that injects SEMS auth header. The caller is expected
 * to provide a full URL. This keeps the service small and easy to integrate
 * with whatever SEMS endpoint the project needs.
 */
export async function semsFetch(env: Env, url: string, init: RequestInit = {}) {
  ensureConfig(env);

  const headers = new Headers(init.headers ?? {});
  if (!headers.has("Authorization")) {
    headers.set("Authorization", buildBasicAuthHeader(env));
  }

  const res = await fetch(url, { ...init, headers });

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(json));
    return json;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `SEMS request failed: ${res.status}`);
  }

  return await res.text();
}

/**
 * Lightweight health check helper. If no external SEMS endpoint is known,
 * this simply validates config and returns a small object indicating readiness.
 */
export function health(env: Env) {
  try {
    ensureConfig(env);
    return { ready: true, email: env.SEMS_EMAIL };
  } catch (err: any) {
    return { ready: false, error: err.message };
  }
}

export default {
  buildBasicAuthHeader,
  semsFetch,
  health,
};