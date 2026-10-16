import { defineConfig } from "drizzle-kit";
import { Config, Effect, Option } from "effect";

// `generate` needs no connection; `migrate` reads the target from the environment only.
const url = Effect.runSync(Config.option(Config.String("DATABASE_URL")));

const base = {
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/schema.ts",
} as const;

export default defineConfig(
  Option.isSome(url) ? { ...base, dbCredentials: { url: url.value } } : base
);
