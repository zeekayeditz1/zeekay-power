import { defineConfig } from "vitest/config";

/*
| Plain Node test project for the pure decision logic (the auto-shift planner,
| the SOC estimator). These touch no bindings, so they must not drag in the
| workers pool — that one needs a Cloudflare login because the D1 binding is
| declared `remote: true`, which would make `npm test` unrunnable offline and
| in CI. Worker-level integration tests still live under vitest.config.mts.
*/
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/unit/**/*.spec.ts"],
  },
});
