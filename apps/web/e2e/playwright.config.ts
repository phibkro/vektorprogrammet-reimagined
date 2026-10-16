/**
 * Playwright for the browser tests. `e2e/run.ts` starts the database and `vp dev` and sets the environment
 * this file reads; running `playwright test` by hand needs the same two variables.
 */
import { defineConfig } from "@playwright/test";
import { Config, Effect } from "effect";

const environment = Effect.runSync(
  Config.all({ baseUrl: Config.String("E2E_BASE_URL") })
);

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: true,
  fullyParallel: false,
  outputDir: "../test-results",
  reporter: [["list"]],
  retries: 0,
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // The dev server compiles on demand, and a test is a whole story of dialogs and round trips.
  timeout: 90_000,
  use: {
    baseURL: environment.baseUrl,
    locale: "nb-NO",
    screenshot: "only-on-failure",
    timezoneId: "Europe/Oslo",
    trace: "retain-on-failure",
  },
  // One worker: the journey is one story over one database.
  workers: 1,
});
