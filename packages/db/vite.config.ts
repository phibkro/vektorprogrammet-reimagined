import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Real-PostgreSQL suites create a database and apply migrations in their layer.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
