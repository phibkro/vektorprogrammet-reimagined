import { assert, describe, it } from "@effect/vitest";
import { withClient } from "@vektorprogrammet/db/testing";
import { Array as Arr, Config, Crypto, Effect } from "effect";

import { createAdminClient, createWorkerClient } from "../src/server/supabase";
import { webCryptoLayer } from "../src/server/webCrypto";

describe("Supabase session cookies", () => {
  it.live("signs a synthetic user in, verifies the cookie and signs out", () =>
    Effect.gen(function* exerciseSessionCookies() {
      const config = {
        SUPABASE_PUBLISHABLE_KEY: yield* Config.String(
          "SUPABASE_PUBLISHABLE_KEY"
        ),
        SUPABASE_SECRET_KEY: yield* Config.String("SUPABASE_SECRET_KEY"),
        SUPABASE_URL: yield* Config.String("SUPABASE_URL"),
      };

      const crypto = yield* Crypto.Crypto;
      const email = `session-${yield* crypto.randomUUIDv4()}@example.org`;
      const password = `Test-${yield* crypto.randomUUIDv4()}`;
      const admin = createAdminClient(config);
      yield* Effect.acquireUseRelease(
        Effect.promise(() =>
          admin.auth.admin.createUser({
            app_metadata: { personId: 42 },
            email,
            email_confirm: true,
            password,
          })
        ).pipe(
          Effect.map((created) => {
            assert.isNull(created.error);

            return created.data.user.id;
          })
        ),
        () =>
          Effect.gen(function* verifySessionCookies() {
            const responseHeaders = new Headers();

            const client = createWorkerClient(
              config,
              new Request("http://localhost/"),
              responseHeaders
            );

            const signedIn = yield* Effect.promise(() =>
              client.auth.signInWithPassword({ email, password })
            );

            const database = yield* Config.Redacted("DATABASE_URL");
            const id = signedIn.data.user?.id;
            assert.isDefined(id);

            const rows = yield* withClient(
              database,
              (sql) => sql`select
              (select count(*)::integer from vektor_private.users where id = ${id} and email = ${email} and person_id = '42') as users,
              (select count(*)::integer from vektor_private.identities where user_id = ${id}) as identities,
              (select count(*)::integer from vektor_private.sessions where user_id = ${id}) as sessions`
            );

            assert.deepStrictEqual(rows, [
              { identities: 1, sessions: 1, users: 1 },
            ]);
            assert.isNull(signedIn.error);

            const cookie = Arr.join(
              Arr.map(
                responseHeaders.getSetCookie(),
                (entry) => entry.split(";", 1)[0]
              ),
              "; "
            );

            const logoutHeaders = new Headers();

            const next = createWorkerClient(
              config,
              new Request("http://localhost/", { headers: { cookie } }),
              logoutHeaders
            );

            const current = yield* Effect.promise(() => next.auth.getUser());
            assert.isNull(current.error);
            assert.equal(current.data.user?.app_metadata.personId, 42);

            const signedOut = yield* Effect.promise(() =>
              next.auth.signOut({ scope: "local" })
            );

            assert.isNull(signedOut.error);
            const session = yield* Effect.promise(() => next.auth.getSession());
            assert.isNull(session.error);
            assert.isNull(session.data.session);
          }),
        (id) =>
          Effect.promise(() => admin.auth.admin.deleteUser(id)).pipe(
            Effect.tap((deleted) =>
              Effect.sync(() => {
                assert.isNull(deleted.error);
              })
            )
          )
      );
    }).pipe(Effect.provide(webCryptoLayer), Effect.orDie)
  );
});
