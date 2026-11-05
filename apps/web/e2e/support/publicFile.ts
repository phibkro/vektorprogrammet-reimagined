import { PgClient } from "@effect/sql-pg";
import { createClient } from "@supabase/supabase-js";
import { Config, Crypto, Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { fileKeyFor } from "../../src/features/files/domain/fileType";

export const PUBLIC_FILE_FIXTURE_TEXT =
  "Vektorprogrammet local public-file fixture.\n";

const FILE_NAME = "vektorprogrammet-e2e-fixture.bin";
const FILE_BYTES = new TextEncoder().encode(PUBLIC_FILE_FIXTURE_TEXT);

/** Seed the fixture in the same private Storage bucket and database used by the Worker. */
export const seedPublicFile = Effect.fn("seedPublicFile")(
  function* seedPublicFile(databaseUrl: Redacted.Redacted) {
    const crypto = yield* Crypto.Crypto;

    const digest = yield* crypto
      .digest("SHA-256", FILE_BYTES)
      .pipe(Effect.orDie);

    const key = fileKeyFor(digest, "application/octet-stream");
    const origin = yield* Config.String("SUPABASE_URL");
    const secret = yield* Config.Redacted("SUPABASE_SECRET_KEY");

    const client = createClient(origin, Redacted.value(secret), {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const bucket = client.storage.from("public-files");

    const result = yield* Effect.callback<
      Awaited<ReturnType<typeof bucket.upload>>
    >((resume) => {
      void bucket
        .upload(key, FILE_BYTES, {
          contentType: "application/octet-stream",
          upsert: true,
        })
        .then(
          (value) => {
            resume(Effect.succeed(value));
          },
          () => {
            resume(Effect.die("Local storage upload failed"));
          }
        );
    });

    if (result.error) {
      return yield* Effect.die(result.error);
    }

    yield* Effect.gen(function* insertFileRecord() {
      const sql = yield* SqlClient;
      yield* sql`insert into public_file (key, sha256, content_type, name, size, uploaded_at) values (${key}, ${key.slice(0, 64)}, 'application/octet-stream', ${FILE_NAME}, ${FILE_BYTES.byteLength}, now()) on conflict (key) do nothing`;
    }).pipe(
      Effect.provide(PgClient.layer({ maxConnections: 1, url: databaseUrl }))
    );

    return key;
  }
);
