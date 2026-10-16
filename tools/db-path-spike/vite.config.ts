import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Each suite creates a disposable database and applies the spike migrations in its layer.
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
