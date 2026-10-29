import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // The layer gunzips and digests every committed vectors file, 175 MB for `teams`: about 1 s alone, 5 s with two
    // busy loops on the two CPUs of CI's runner and up to 11.5 s at worst in 20 runs, against Vitest's 10 s.
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts"],
  },
});
