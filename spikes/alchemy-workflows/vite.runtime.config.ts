import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Every test starts real `alchemy dev` runtimes (bundle, sidecar, workerd) and waits for durable timers, so the
    // budgets are minutes, and the files run one after another: they share the machine's CPU and one PostgreSQL server.
    fileParallelism: false,
    hookTimeout: 600_000,
    include: ["test/runtime/*.test.ts"],
    testTimeout: 600_000,
  },
});
