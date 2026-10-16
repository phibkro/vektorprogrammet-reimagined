import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { hyperdrive, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import { Config, Effect } from "effect";
import emdash from "emdash/astro";

import { ownExternalRequire } from "./build/ownExternalRequire.ts";

// Alchemy builds with its own Cloudflare adapter and fails the build when this file configures one. The local runs
// (`bun run dev`, the browser tests) set CMS_STANDALONE=1 and use @astrojs/cloudflare over wrangler.json instead.
const standalone =
  Effect.runSync(
    Config.String("CMS_STANDALONE").pipe(Config.withDefault(""))
  ) === "1";

export default defineConfig({
  adapter: standalone ? cloudflare() : undefined,
  integrations: [
    react(),
    emdash({
      database: hyperdrive({ binding: "HYPERDRIVE" }),
      storage: r2({ binding: "MEDIA" }),
    }),
  ],
  output: "server",
  // `ownExternalRequire`: the bundle's `require("events")` and friends become imports (see its comment).
  vite: {
    optimizeDeps: { include: ["pg"] },
    plugins: [ownExternalRequire()],
  },
});
