import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The round trip creates a MySQL and a PostgreSQL database, applies the
    // migrations and imports twice; each real-database step gets a minute.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
