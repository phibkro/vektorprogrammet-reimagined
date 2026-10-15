import { defineConfig } from "drizzle-kit";

// `generate` needs no connection; `migrate` reads the target from the environment only.
const url = process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  ...(url === undefined ? {} : { dbCredentials: { url } }),
});
