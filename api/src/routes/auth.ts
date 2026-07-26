import { Hono } from "hono";
import { login, register } from "../controllers/auth";
import { authMiddleware, AuthVariables } from "../middleware/auth";

const auth = new Hono<{ Variables: AuthVariables }>();

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