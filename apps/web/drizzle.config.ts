import { defineConfig } from "drizzle-kit";
import { Config, Effect, Option } from "effect";

// Schema generation is offline; migration credentials are never runtime credentials.
const url = Effect.runSync(
  Config.option(Config.String("MIGRATION_DATABASE_URL"))
);

const base = {
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/adapters/db/schema.ts",
} as const;

export default defineConfig(
  Option.isSome(url) ? { ...base, dbCredentials: { url: url.value } } : base
);
