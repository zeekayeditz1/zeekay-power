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
  ]);

  // Seed a couple of events the first time so the panel isn't empty.
  const count = await env.zeekay_power_db
    .prepare(`SELECT COUNT(*) AS n FROM app_events`)
    .first<{ n: number }>();

  if (!count || count.n === 0) {
    await logEvent(env, "system", "Control center online", "Dashboard connected to Zeekay Power API");
    await logEvent(env, "battery", "Battery healthy", "State of charge within normal range");
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
