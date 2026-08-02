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
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(PREFIX);
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
  try { await env.zeekay_power_db.prepare(`UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(row.id).run(); } catch {}
  return { ...row, revoked: !!row.revoked };
}
