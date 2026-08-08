/*
| API keys for programmatic access to this app's own API (scripts, the
| WapdaWatch app, Home Assistant, etc.) — separate from the browser JWT
| login. Keys are high-entropy random tokens; only a SHA-256 hash is ever
| stored, the plaintext is returned exactly once, at creation time.
*/
export interface ApiKeyEnv { zeekay_power_db: D1Database }

export type ApiKeyScope = "full" | "read_only";
export interface ApiKeyRecord {
  id: string; name: string; scope: ApiKeyScope;
  created_at: string; last_used_at: string | null; revoked: boolean;
}

const PREFIX = "zk_";

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return PREFIX + b64;
}
/** Exact shape of a key produced by randomKey(): "zk_" + 43 base64url chars
 *  (32 random bytes, unpadded). Matching the full shape — not just the prefix —
 *  keeps malformed credentials out of the D1 lookup path entirely. */
const KEY_PATTERN = /^zk_[A-Za-z0-9_-]{43}$/;

export function looksLikeApiKey(token: string): boolean {
  return KEY_PATTERN.test(token);
}

export async function createApiKey(env: ApiKeyEnv, name: string, scope: ApiKeyScope) {
  const id = crypto.randomUUID();
  const key = randomKey();
  const hash = await sha256Hex(key);
  await env.zeekay_power_db
    .prepare(`INSERT INTO api_keys (id, name, key_hash, scope) VALUES (?, ?, ?, ?)`)
    .bind(id, name, hash, scope)
    .run();
  return { id, name, scope, key }; // `key` (plaintext) is ONLY ever returned here, right now
}

export async function listApiKeys(env: ApiKeyEnv): Promise<ApiKeyRecord[]> {
  const res: any = await env.zeekay_power_db
    .prepare(`SELECT id, name, scope, created_at, last_used_at, revoked FROM api_keys ORDER BY created_at DESC`)
    .all();
  return (res?.results || []).map((r: any) => ({ ...r, revoked: !!r.revoked }));
}

export async function revokeApiKey(env: ApiKeyEnv, id: string): Promise<boolean> {
  const res: any = await env.zeekay_power_db.prepare(`UPDATE api_keys SET revoked = 1 WHERE id = ?`).bind(id).run();
  return (res?.meta?.changes ?? 0) > 0;
}

/** Validate a presented key (from the Authorization header). Returns the
 *  matching record (and best-effort bumps last_used_at) or null. */
export async function validateApiKey(env: ApiKeyEnv, presented: string): Promise<ApiKeyRecord | null> {
  if (!looksLikeApiKey(presented)) return null;
  const hash = await sha256Hex(presented);
  const row: any = await env.zeekay_power_db
    .prepare(`SELECT id, name, scope, created_at, last_used_at, revoked FROM api_keys WHERE key_hash = ?`)
    .bind(hash)
    .first();
  if (!row || row.revoked) return null;
  if (row.scope !== "full" && row.scope !== "read_only") return null;
  // Bump last_used_at at most once every 5 minutes — a polling client would
  // otherwise write to D1 on every single request.
  try {
    await env.zeekay_power_db
      .prepare(
        `UPDATE api_keys
       SET last_used_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND (last_used_at IS NULL OR last_used_at < datetime('now', '-5 minutes'))`
      )
      .bind(row.id)
      .run();
  } catch {}
  return { ...row, revoked: !!row.revoked };
}
