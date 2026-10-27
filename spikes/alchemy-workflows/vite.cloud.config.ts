import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // The cloud run drives a deployed Workflow through the Cloudflare API and waits for durable waits and sleeps of
    // minutes, so the budgets are long, and the scenarios run one after another in one file.
    fileParallelism: false,
    hookTimeout: 900_000,
    include: ["test/cloud/*.test.ts"],
    testTimeout: 900_000,
  },
});
