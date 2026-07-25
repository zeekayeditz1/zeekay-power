import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import { getUserById } from "../services/userService";

const user = new Hono();

user.use("*", authMiddleware);

/*
|--------------------------------------------------------------------------
| Current User
|--------------------------------------------------------------------------
*/

user.get("/me", async (c) => {
  const currentUser = c.get("user");

  const dbUser = await getUserById(
    c.env as any,
    currentUser.id
  );

  if (!dbUser) {
    return c.json(
      {
        success: false,
        message: "User not found",
      },
      404
    );
  }

  return c.json({
    success: true,
    user: {
      id: dbUser.id,
      name: dbUser.name,
      email: dbUser.email,
      created_at: dbUser.created_at,
    },
  });
});

/*
|--------------------------------------------------------------------------
| Profile
|--------------------------------------------------------------------------
*/

user.get("/profile", async (c) => {
  const currentUser = c.get("user");

  const dbUser = await getUserById(
    c.env as any,
    currentUser.id
  );

  if (!dbUser) {
    return c.json(
      {
        success: false,
        message: "User not found",
      },
      404
    );
  }

  return c.json({
    success: true,
    profile: {
      id: dbUser.id,
      name: dbUser.name,
      email: dbUser.email,
      created_at: dbUser.created_at,
    },
  });
});

export default user;