import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // The PostgreSQL suites create a disposable database and apply the repository's migrations in their layer.
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
