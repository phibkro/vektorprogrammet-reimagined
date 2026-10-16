import { defineConfig } from "drizzle-kit";
import { Config, Effect } from "effect";

// `generate` needs no connection; `migrate` reads the target from the environment only
// (the direct `neondb_owner` URL, never stored). The journal lives in its own table in
// `public`, so Phase 1's `drizzle.__drizzle_migrations` and its ordering stay untouched,
// and outside the spike schema, which the first migration creates.
const target = Effect.runSync(
  Config.String("DATABASE_URL").pipe(
    Config.map((url) => ({ dbCredentials: { url } })),
    Config.withDefault({})
  )
);

export default defineConfig({
  dialect: "postgresql",
  migrations: { schema: "public", table: "spike_0000_migrations" },
  out: "./drizzle",
  schema: "./src/schema.ts",
  schemaFilter: ["spike_0000"],
  ...target,
});
