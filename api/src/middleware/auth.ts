import { Context, Next } from "hono";
import { verifyToken, JwtPayload } from "../utils/jwt";
import { looksLikeApiKey, validateApiKey } from "../services/apiKeys";

/**
 * Hono context variables set by authMiddleware.
 * Type route apps with `new Hono<{ Variables: AuthVariables }>()`
 * so `c.get("user")` is strongly typed.
 */
export type AuthVariables = {
  user: JwtPayload;
  authType: "jwt" | "apikey";
  apiKeyScope?: "full" | "read_only";
};

export async function authMiddleware(
  c: Context,
  next: Next
): Promise<Response | void> {
  try {
    const authHeader = c.req.header("Authorization");

    if (!authHeader) {
      return c.json(
        {
          success: false,
          message: "Authorization header is missing",
        },
        401
      );
    }

    if (!authHeader.startsWith("Bearer ")) {
      return c.json(
        {
          success: false,
          message: "Invalid authorization format",
        },
        401
      );
    }

    const token = authHeader.substring(7).trim();

    if (!token) {
      return c.json(
        {
          success: false,
          message: "Token is missing",
        },
        401
      );
    }

    if (token.length > 4096) {
      return c.json(
        {
          success: false,
          message: "Credential is too long",
        },
        401
      );
    }

    const env = c.env as any;

    // API keys (prefix "zk_") are a separate credential from the browser JWT
    // login — same header, different validation path.
    if (looksLikeApiKey(token)) {
      const key = await validateApiKey(env, token);
      if (!key) {
        return c.json({ success: false, message: "Invalid or revoked API key" }, 401);
      }
      c.set("user", { id: key.id, name: key.name, email: "api-key" });
      c.set("authType", "apikey");
      c.set("apiKeyScope", key.scope);
      await next();
      return;
    }

    const user: JwtPayload = await verifyToken(
      token,
      env.JWT_SECRET
    );

    c.set("user", user);
    c.set("authType", "jwt");

    await next();
  } catch (error: any) {
    return c.json(
      {
        success: false,
        message: "Invalid or expired token",
      },
      401
    );
  }
}

export function getCurrentUser(c: Context): JwtPayload {
  return c.get("user");
}

/** Reject requests authenticated with a read_only API key. JWT (browser
 *  login) requests are never affected — only used to gate control routes
 *  (relay, poll, auto-shift settings) against a restricted key. */
export async function requireFullAccess(c: Context, next: Next): Promise<Response | void> {
  if (c.get("apiKeyScope") === "read_only") {
    return c.json({ success: false, message: "This API key is read-only and cannot perform this action" }, 403);
  }
  await next();
}

/** Reject anything but a real browser JWT login — used on the API-key
 *  management routes themselves, so a leaked key can never mint or
 *  revoke other keys. */
export async function requireJwt(c: Context, next: Next): Promise<Response | void> {
  if (c.get("authType") !== "jwt") {
    return c.json({ success: false, message: "Sign in through the dashboard to manage API keys" }, 403);
  }
  await next();
}