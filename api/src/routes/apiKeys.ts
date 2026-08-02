import { Hono } from "hono";
import { authMiddleware, requireJwt } from "../middleware/auth";
import { ensureTables, logEvent } from "../services/dashboardStore";
import { createApiKey, listApiKeys, revokeApiKey, ApiKeyScope } from "../services/apiKeys";

/*
|--------------------------------------------------------------------------
| API key management — creating, listing, revoking programmatic access
| keys for this app's own API. Deliberately requires a real browser JWT
| login (requireJwt) for every route here, even though the auth middleware
| also accepts API keys elsewhere — a leaked key must never be able to
| mint itself more access or revoke another key.
|--------------------------------------------------------------------------
*/

const apiKeys = new Hono();

apiKeys.use("*", async (c, next) => {
  await ensureTables(c.env as any);
  return next();
});
apiKeys.use("*", authMiddleware);
apiKeys.use("*", requireJwt);

/* ---------- GET /api/keys — list (never returns plaintext) ---------- */
apiKeys.get("/", async (c) => {
  const keys = await listApiKeys(c.env as any);
  return c.json({ success: true, keys });
});

/* ---------- POST /api/keys { name, scope } — create, returns plaintext ONCE ---------- */
apiKeys.post("/", async (c) => {
  let body: any = {};
  try { body = await c.req.json(); } catch { /* ignore */ }

  const name = (typeof body.name === "string" && body.name.trim()) ? body.name.trim().slice(0, 64) : "Unnamed key";
  const scope: ApiKeyScope = body.scope === "read_only" ? "read_only" : "full";

  const created = await createApiKey(c.env as any, name, scope);
  await logEvent(c.env as any, "apikey", "API key created", `"${name}" (${scope === "read_only" ? "read-only" : "full access"})`);

  return c.json({
    success: true,
    id: created.id,
    name: created.name,
    scope: created.scope,
    key: created.key, // plaintext — shown exactly once, never retrievable again
  });
});

/* ---------- DELETE /api/keys/:id — revoke ---------- */
apiKeys.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const ok = await revokeApiKey(c.env as any, id);
  if (!ok) return c.json({ success: false, error: "key not found" }, 404);
  await logEvent(c.env as any, "apikey", "API key revoked", id);
  return c.json({ success: true });
});

export default apiKeys;
