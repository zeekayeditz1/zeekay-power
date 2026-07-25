import { Context } from "hono";
import { z } from "zod";

import {
  createUser,
  emailExists,
  getUserByEmail,
} from "../services/userService";

import { verifyPassword } from "../utils/hash";
import { createToken } from "../utils/jwt";

const registerSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(6).max(100),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export async function register(c: Context) {
  try {
    const body = await c.req.json();

    const data = registerSchema.parse(body);

    const env = c.env as any;

    const exists = await emailExists(
      env,
      data.email
    );

    if (exists) {
      return c.json(
        {
          success: false,
          message: "Email already exists",
        },
        409
      );
    }

    const userId = await createUser(
      env,
      {
        name: data.name,
        email: data.email,
        password: data.password,
      }
    );

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
    return c.json(
      {
        success: false,
        error: error.message,
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
    return c.json(
      {
        success: false,
        error: error.message,
      },
      400
    );
  }
}