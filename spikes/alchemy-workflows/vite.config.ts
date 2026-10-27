import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // The default suite is hermetic and fast (no PostgreSQL, no workerd): `vp run -r test` runs it in the pre-push
    // hook. The runtime tests, which start real `alchemy dev` runtimes, are `bun run test:runtime`.
    include: ["test/*.test.ts"],
  },
});
