import { Hono } from "hono";
import { cors } from "hono/cors";

import authRoutes from "./routes/auth";
import userRoutes from "./routes/user";
import dashboardRoutes from "./routes/dashboard";
import apiKeyRoutes from "./routes/apiKeys";
import { runSocTick } from "./services/socPipeline";

export interface Env {
  zeekay_power_db: D1Database;

  JWT_SECRET: string;
  APP_NAME: string;

  TUYA_CLIENT_ID: string;
  TUYA_CLIENT_SECRET: string;
  TUYA_DEVICE_ID: string;
  TUYA_REGION: string;

  SEMS_EMAIL: string;
  SEMS_PASSWORD: string;
  SEMS_STATION_ID: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],
  })
);

/*
|--------------------------------------------------------------------------
| Root
|--------------------------------------------------------------------------
*/

app.get("/", (c) => {
  return c.json({
    success: true,
    app: c.env.APP_NAME,
    message: "Zeekay Power API",
  });
});

/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

app.get("/api/health", (c) => {
  return c.json({
    success: true,
    app: c.env.APP_NAME,
    version: "1.0.0",
    status: "online",
    timestamp: new Date().toISOString(),
  });
});

/*
|--------------------------------------------------------------------------
| Database Test
|--------------------------------------------------------------------------
*/

app.get("/api/db-test", async (c) => {
  try {
    const result = await c.env.zeekay_power_db
      .prepare("SELECT COUNT(*) AS total FROM users")
      .first<{ total: number }>();

    return c.json({
      success: true,
      database: "Connected",
      users: result?.total ?? 0,
    });
  } catch (error: any) {
    return c.json(
      {
        success: false,
        database: "Disconnected",
        error: error.message,
      },
      500
    );
  }
});

/*
|--------------------------------------------------------------------------
| API Routes
|--------------------------------------------------------------------------
*/

app.route("/api/auth", authRoutes);
app.route("/api/user", userRoutes);
app.route("/api", dashboardRoutes);
app.route("/api/keys", apiKeyRoutes);

/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.notFound((c) => {
  return c.json(
    {
      success: false,
      message: "Route not found",
    },
    404
  );
});

/*
|--------------------------------------------------------------------------
| Error Handler
|--------------------------------------------------------------------------
*/

app.onError((err, c) => {
  console.error(err);

  return c.json(
    {
      success: false,
      message: "Internal Server Error",
      error: err.message,
    },
    500
  );
});

export default {
  fetch: app.fetch,
  async scheduled(_event: any, env: Env, ctx: any) {
    ctx.waitUntil(
      (async () => {
        try { await runSocTick(env as any); }
        catch (e: any) { console.error("soc tick error:", e?.message); }
      })()
    );
  },
};