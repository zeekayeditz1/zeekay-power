/*
|--------------------------------------------------------------------------
| Dashboard store
|--------------------------------------------------------------------------
| Tiny D1-backed key/value + event log used by the dashboard endpoints.
| Tables are created on demand so no manual migration is required, and
| they are also declared in database/schema.sql for completeness.
|--------------------------------------------------------------------------
*/

export interface StoreEnv {
  zeekay_power_db: D1Database;
}

let ready = false;

export async function ensureTables(env: StoreEnv): Promise<void> {
  if (ready) return;

  await env.zeekay_power_db.batch([
    env.zeekay_power_db.prepare(
      `CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    ),
    env.zeekay_power_db.prepare(
      `CREATE TABLE IF NOT EXISTS app_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    ),
    env.zeekay_power_db.prepare(
      `CREATE TABLE IF NOT EXISTS battery_history (
        ts INTEGER PRIMARY KEY,
        v REAL, p REAL,
        soc_blended REAL, soc_v REAL, soc_cc REAL,
        bms_soc REAL, anchored INTEGER
      )`
    ),
    env.zeekay_power_db.prepare(
      `CREATE TABLE IF NOT EXISTS daily_energy_log (
        date TEXT PRIMARY KEY,
        wapda_import_kwh REAL, solar_kwh REAL,
        charge_kwh REAL, discharge_kwh REAL, pv_peak_w REAL
      )`
    ),
    env.zeekay_power_db.prepare(
      `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL DEFAULT 'read_only' CHECK (scope IN ('full', 'read_only')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_used_at TEXT,
        revoked INTEGER NOT NULL DEFAULT 0
      )`
    ),
    env.zeekay_power_db.prepare(
      `CREATE TABLE IF NOT EXISTS auth_rate_limits (
        key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        attempts INTEGER NOT NULL
      )`
    ),
  ]);

  // Seed a couple of events the first time so the panel isn't empty.
  const count = await env.zeekay_power_db
    .prepare(`SELECT COUNT(*) AS n FROM app_events`)
    .first<{ n: number }>();

  if (!count || count.n === 0) {
    await logEvent(env, "system", "Control center online", "Dashboard connected to Zeekay Power API");
  }

  ready = true;
}

export async function getState(
  env: StoreEnv,
  key: string,
  fallback: string
): Promise<string> {
  const row = await env.zeekay_power_db
    .prepare(`SELECT value FROM app_state WHERE key = ? LIMIT 1`)
    .bind(key)
    .first<{ value: string }>();

  return row?.value ?? fallback;
}

export async function setState(
  env: StoreEnv,
  key: string,
  value: string
): Promise<void> {
  await env.zeekay_power_db
    .prepare(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
    )
    .bind(key, value)
    .run();
}

/*
| Mutual exclusion for the SOC tick.
|
| The 1-minute cron and a manual "Force poll" click can land at the same
| moment, and two concurrent ticks could each independently decide to fire a
| Tuya relay command. The lock is a single conditional UPSERT: the WHERE clause
| only matches when the stored expiry has already passed, so exactly one caller
| can ever win. Returns the expiry it claimed, or null if someone else holds it.
*/
export async function acquireTickLock(
  env: StoreEnv,
  nowEpoch: number,
  ttlSeconds = 120
): Promise<number | null> {
  const expiresAt = nowEpoch + ttlSeconds;
  const result: any = await env.zeekay_power_db
    .prepare(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES ('tick_lock', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = CURRENT_TIMESTAMP
       WHERE CAST(app_state.value AS INTEGER) <= ?`
    )
    .bind(String(expiresAt), nowEpoch)
    .run();

  return (result.meta?.changes ?? 0) > 0 ? expiresAt : null;
}

/** Release a lock only if we still hold it (value still matches our expiry). */
export async function releaseTickLock(env: StoreEnv, expiresAt: number): Promise<void> {
  await env.zeekay_power_db
    .prepare(`DELETE FROM app_state WHERE key = 'tick_lock' AND value = ?`)
    .bind(String(expiresAt))
    .run();
}

/*
| Fixed-window login throttle, keyed by a hash of the client IP so raw
| addresses are never stored. Counts the attempt and reports whether the
| caller is still under the limit.
*/
export async function consumeLoginAttempt(
  env: StoreEnv,
  clientAddress: string,
  nowEpoch: number,
  maxAttempts = 10,
  windowSeconds = 15 * 60
): Promise<{ allowed: boolean; retryAfter: number }> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientAddress));
  const key = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const resetBefore = nowEpoch - windowSeconds;

  await env.zeekay_power_db
    .prepare(
      `INSERT INTO auth_rate_limits (key, window_start, attempts)
     VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       attempts = CASE WHEN auth_rate_limits.window_start <= ? THEN 1 ELSE auth_rate_limits.attempts + 1 END,
       window_start = CASE WHEN auth_rate_limits.window_start <= ? THEN excluded.window_start ELSE auth_rate_limits.window_start END`
    )
    .bind(key, nowEpoch, resetBefore, resetBefore)
    .run();

  const row = await env.zeekay_power_db
    .prepare(`SELECT window_start, attempts FROM auth_rate_limits WHERE key = ?`)
    .bind(key)
    .first<{ window_start: number; attempts: number }>();

  const attempts = Number(row?.attempts ?? maxAttempts + 1);
  const retryAfter = Math.max(1, Number(row?.window_start ?? nowEpoch) + windowSeconds - nowEpoch);

  return { allowed: attempts <= maxAttempts, retryAfter };
}

export async function logEvent(
  env: StoreEnv,
  type: string,
  title: string,
  detail?: string
): Promise<void> {
  await env.zeekay_power_db
    .prepare(`INSERT INTO app_events (type, title, detail) VALUES (?, ?, ?)`)
    .bind(type, title, detail ?? null)
    .run();
}

export interface EventRow {
  id: number;
  type: string;
  title: string;
  detail: string | null;
  at: string;
}

export async function getEvents(
  env: StoreEnv,
  limit: number
): Promise<EventRow[]> {
  const res = await env.zeekay_power_db
    .prepare(`SELECT id, type, title, detail, at FROM app_events ORDER BY id DESC LIMIT ?`)
    .bind(Math.max(1, Math.min(50, limit)))
    .all<EventRow>();

  return res.results ?? [];
}
