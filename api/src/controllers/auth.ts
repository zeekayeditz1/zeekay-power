import { Context } from "hono";
import { z } from "zod";

import {
  createFirstUser,
  getUserByEmail,
  countUsers,
} from "../services/userService";

import { consumeLoginAttempt } from "../services/dashboardStore";
import { verifyPassword } from "../utils/hash";
import { createToken } from "../utils/jwt";

const registerSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(100),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(100),
});

export async function register(c: Context) {
  try {
    const body = await c.req.json();

    const data = registerSchema.parse(body);

    const env = c.env as any;

    // Bootstrap-only: registration is open only until the first account
    // exists. This keeps the private control dashboard closed to public
    // sign-ups once it has been set up.
    if ((await countUsers(env)) > 0) {
      return c.json({ success: false, message: "Registration is closed" }, 403);
    }

    const userId = await createFirstUser(
      env,
      {
        name: data.name,
        email: data.email,
        password: data.password,
      }
    );

    // Lost the race against a concurrent bootstrap request.
    if (!userId) {
      return c.json({ success: false, message: "Registration is closed" }, 403);
    }

    const token = await createToken(
      {
        id: userId,
        name: data.name,
        email: data.email,
      },
      env.JWT_SECRET
    );

    return c.json({
      success: true,
      message: "Registration successful",
      token,
      user: {
        id: userId,
        name: data.name,
        email: data.email,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return c.json({ success: false, message: "Invalid registration details" }, 400);
    }
    console.error("registration failed:", error?.message);
    return c.json(
      {
        success: false,
        message: "Registration failed",
      },
      400
    );
  }
}

export async function login(c: Context) {
  try {
    const body = await c.req.json();

    const data = loginSchema.parse(body);

    const env = c.env as any;

    // Throttle credential stuffing before touching the password hash.
    const clientAddress = c.req.header("CF-Connecting-IP") || "unknown-client";
    const limit = await consumeLoginAttempt(env, clientAddress, Math.floor(Date.now() / 1000));
    if (!limit.allowed) {
      c.header("Retry-After", String(limit.retryAfter));
      return c.json({ success: false, message: "Too many login attempts; try again later" }, 429);
    }

    const user = await getUserByEmail(
      env,
      data.email
    );

    if (!user) {
      return c.json(
        {
          success: false,
          message: "Invalid email or password",
        },
        401
      );
    }

    const passwordValid =
      await verifyPassword(
        data.password,
        user.password_hash
      );

    if (!passwordValid) {
      return c.json(
        {
          success: false,
          message: "Invalid email or password",
        },
        401
      );
    }

    const token = await createToken(
      {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      env.JWT_SECRET
    );

    return c.json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return c.json({ success: false, message: "Invalid login details" }, 400);
    }
    console.error("login failed:", error?.message);
    return c.json(
      {
        success: false,
        message: "Login failed",
      },
      400
    );
  }
}