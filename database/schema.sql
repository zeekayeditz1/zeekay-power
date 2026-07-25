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