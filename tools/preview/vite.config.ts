import { defineConfig } from "vite-plus";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], maxWorkers: 1 },
});
