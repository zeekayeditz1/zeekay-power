import { Hono } from "hono";
import { login, register } from "../controllers/auth";
import { authMiddleware, AuthVariables } from "../middleware/auth";
import { ensureTables } from "../services/dashboardStore";

const auth = new Hono<{ Variables: AuthVariables }>();

// The login/register handlers touch tables created lazily by ensureTables
// (auth_rate_limits in particular), so make sure the schema exists before any
// auth route runs — a cold worker must not 500 on the very first login.
auth.use("*", async (c, next) => {
  await ensureTables(c.env as any);
  await next();
});

/*
|--------------------------------------------------------------------------
| Public Routes
|--------------------------------------------------------------------------
*/

auth.post("/register", register);

auth.post("/login", login);

/*
|--------------------------------------------------------------------------
| Protected Routes
|--------------------------------------------------------------------------
*/

auth.get("/me", authMiddleware, async (c) => {
  const user = c.get("user");

  return c.json({
    success: true,
    user,
  });
});

/*
|--------------------------------------------------------------------------
| Logout
|--------------------------------------------------------------------------
| JWT is stateless.
| Android/Web simply delete the stored token.
|--------------------------------------------------------------------------
*/

auth.post("/logout", authMiddleware, async (c) => {
  return c.json({
    success: true,
    message: "Logout successful",
  });
});

export default auth;