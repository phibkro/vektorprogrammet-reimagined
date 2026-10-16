import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Real-PostgreSQL suites create a database and apply migrations in their layer.
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
