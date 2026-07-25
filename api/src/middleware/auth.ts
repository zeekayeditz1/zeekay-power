import { Context, Next } from "hono";
import { verifyToken, JwtPayload } from "../utils/jwt";

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
          message: "JWT token is missing",
        },
        401
      );
    }

    const env = c.env as any;

    const user: JwtPayload = await verifyToken(
      token,
      env.JWT_SECRET
    );

    c.set("user", user);

    await next();
  } catch (error: any) {
    return c.json(
      {
        success: false,
        message: "Invalid or expired token",
        error: error.message,
      },
      401
    );
  }
}

export function getCurrentUser(c: Context): JwtPayload {
  return c.get("user");
}