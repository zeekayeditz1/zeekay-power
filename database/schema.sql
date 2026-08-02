-- ==========================================
-- Zeekay Power Database Schema v1
-- ==========================================

PRAGMA foreign_keys = ON;

-- ==========================
-- USERS
-- ==========================
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==========================
-- DEVICES
-- ==========================
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    device_uid TEXT NOT NULL UNIQUE,

    relay_state INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id) REFERENCES users(id)
);

-- ==========================
-- TELEMETRY
-- ==========================
CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    device_id TEXT NOT NULL,

    voltage REAL DEFAULT 0,
    current REAL DEFAULT 0,
    power REAL DEFAULT 0,
    energy REAL DEFAULT 0,

    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(device_id) REFERENCES devices(id)
);

-- ==========================
-- USER SESSIONS
-- ==========================
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id) REFERENCES users(id)
);

-- ==========================
-- APP STATE (key/value: relay_state, mode, ...)
-- ==========================
CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==========================
-- APP EVENTS (dashboard activity log)
-- ==========================
CREATE TABLE IF NOT EXISTS app_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- ==========================
-- BATTERY HISTORY (SOC engine)
-- ==========================
CREATE TABLE IF NOT EXISTS battery_history (
    ts INTEGER PRIMARY KEY,          -- unix seconds
    v REAL, p REAL,                  -- battery volts, DC watts (+charge/-discharge)
    soc_blended REAL, soc_v REAL, soc_cc REAL,
    bms_soc REAL, anchored INTEGER
);

-- ==========================
-- DAILY ENERGY LOG (billing-cycle history, resets on the 22nd)
-- ==========================
CREATE TABLE IF NOT EXISTS daily_energy_log (
    date TEXT PRIMARY KEY,           -- YYYY-MM-DD, Pakistan local day
    wapda_import_kwh REAL, solar_kwh REAL,
    charge_kwh REAL, discharge_kwh REAL, pv_peak_w REAL
);

-- ==========================
-- API KEYS (programmatic access, separate from the browser JWT login)
-- ==========================
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,   -- SHA-256 of the key; plaintext is never stored
    scope TEXT NOT NULL DEFAULT 'full',  -- 'full' | 'read_only'
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0
);
