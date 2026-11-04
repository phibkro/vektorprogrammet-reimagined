import { assert, describe, it } from "@effect/vitest";
import { Redacted } from "effect";

import { runtimeDatabaseUrl } from "../src/runtimeUrl.ts";

describe("restricted runtime database URLs", () => {
  it("accepts direct and Supabase pooler logins", () => {
    for (const url of [
      "postgres://vektor_runtime:example@localhost/db",
      "postgres://vektor_runtime_a12b:example@localhost/db",
      "postgresql://vektor_runtime.projectref:example@pooler.example/db?sslmode=require",
    ]) {
      assert.strictEqual(Redacted.value(runtimeDatabaseUrl(url)), url);
    }
  });

  it("rejects administrator credentials, malformed URLs and connection overrides without exposing input", () => {
    for (const url of [
      "not-a-url-secret",
      "postgres://postgres:secret@localhost/db",
      "postgres://vektor_runtime:secret@localhost/db?user=postgres",
      "postgres://vektor_runtime:secret@localhost/db?options=-c%20role%3Dpostgres",
      "postgres://vektor_runtime:secret@localhost/db?service=other",
      "postgres://vektor_runtime:secret@localhost/db?sslmode=require&sslmode=disable",
      "postgres://vektor_runtime:secret@localhost/db#fragment",
    ]) {
      assert.throws(() => {
        runtimeDatabaseUrl(url);
      }, /^DATABASE_URL/u);
    }
  });
});
