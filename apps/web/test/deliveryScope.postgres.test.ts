/**
 * Spec 0017, falsifier 7: a scope builds one database layer, and Better Auth asks the domain through it. Every scope
 * that has Better Auth (`liveRequestLayer`, `deliveryLayer`, `runSignInPerson`, `runAuthRequest`) is given a counted
 * database layer as the full-privilege role, while everything the scope builds from its own `env` (Better Auth's pool,
 * and any further `DatabaseLive` made from `env.HYPERDRIVE`) connects as the role that holds privileges on Better Auth's
 * four tables only. A scope that builds a second database layer for Better Auth's reads therefore has them refused with
 * `permission denied`, and the sign-in below fails; a counter on the injected layer alone could not see that second
 * build. The counter still proves that the injected layer is built once and released once.
 */
import { assert, layer } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
  withClient,
} from "@vektorprogrammet/db/testing";
import {
  AuthTablesDatabaseUrl,
  authTablesRole,
} from "@vektorprogrammet/db/testing/auth-tables-role";
import { PersonId } from "@vektorprogrammet/domain";
import { DateTime, Effect, Exit, Layer, Redacted, Ref } from "effect";
import type { Redacted as RedactedType } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { Auth, authLayer } from "../src/server/auth";
import type { WorkerEnv } from "../src/server/env";
import {
  deliveryLayer,
  liveRequestLayer,
  runAuthRequest,
  runSignInPerson,
} from "../src/server/runtime";
import type { DatabaseServices } from "../src/server/runtime";
import { bcryptFixtures, fixturePassword } from "./support/passwordFixtures";
import { workerEnv } from "./support/workerEnv";

const PERSON = 302;
const ADDRESS = "scope-person@example.org";
const SITE = "https://scope.example";

const seed = Effect.gen(function* seedScopePerson() {
  const database = yield* TestDatabaseUrl;
  const now = yield* DateTime.nowAsDate;

  yield* withClient(database, (sql) =>
    Effect.gen(function* insertRows() {
      yield* sql`insert into department ${sql.insert({ city: "Scopeby", email: "scope@example.org", id: 301, name: "Scope", short_name: "SCP" })}`;
      yield* sql`insert into field_of_study ${sql.insert({ department_id: 301, id: 301, name: "Scope", short_name: "SCP" })}`;
      yield* sql`insert into person ${sql.insert({ email: ADDRESS, email_verified: true, field_of_study_id: 301, id: PERSON, name: "Scope Person" })}`;
      yield* sql`insert into account ${sql.insert({ person_id: PERSON, state: "Active" })}`;
      yield* sql`insert into auth_user ${sql.insert({ created_at: now, email: ADDRESS, email_verified: true, id: "auth-302", name: "Scope Person", person_id: PERSON, updated_at: now })}`;
      yield* sql`insert into auth_account ${sql.insert({ account_id: "auth-302", created_at: now, id: "credential-302", password: bcryptFixtures[0], provider_id: "credential", updated_at: now, user_id: "auth-302" })}`;
    })
  );
});

const signInRequest = () =>
  new Request(`${SITE}/api/auth/sign-in/email`, {
    body: JSON.stringify({
      email: ADDRESS,
      password: fixturePassword,
      rememberMe: true,
    }),
    headers: {
      "content-type": "application/json",
      origin: SITE,
      "user-agent": "scope-client",
    },
    method: "POST",
  });

/** The database layer of a scope, with a probe that counts how often it is built and released. */
const counted = (
  url: RedactedType.Redacted,
  builds: Ref.Ref<number>,
  releases: Ref.Ref<number>
) =>
  Layer.merge(
    DatabaseLive({ maxConnections: 2, url }),
    Layer.effectDiscard(
      Effect.acquireRelease(
        Ref.update(builds, (count) => count + 1),
        () => Ref.update(releases, (count) => count + 1)
      )
    )
  ).pipe(Layer.orDie);

/**
 * Runs `scenario` with the environment of the restricted role and a counted database layer of the full role, and
 * returns what it returned with the number of builds and releases of that layer once the scenario has ended.
 */
const inScope = <A>(
  scenario: (
    env: WorkerEnv,
    database: Layer.Layer<DatabaseServices>
  ) => Effect.Effect<A>
) =>
  Effect.gen(function* runScenario() {
    const full = yield* TestDatabaseUrl;
    const restricted = yield* AuthTablesDatabaseUrl;
    const builds = yield* Ref.make(0);
    const releases = yield* Ref.make(0);

    const result = yield* scenario(
      workerEnv(Redacted.value(restricted)),
      counted(full, builds, releases)
    );

    return {
      builds: yield* Ref.get(builds),
      releases: yield* Ref.get(releases),
      result,
    };
  });

const statusOf = Effect.fn("statusOf")(function* statusOf() {
  const auth = yield* Auth;

  return (yield* auth.handle(signInRequest())).status;
});

const seeded = Layer.effectDiscard(seed).pipe(
  Layer.provideMerge(authTablesRole),
  Layer.provideMerge(migratedTestDatabase),
  Layer.orDie
);

const oneBuildAndAdmitted = (outcome: {
  readonly builds: number;
  readonly releases: number;
  readonly result: number;
}) => {
  assert.strictEqual(outcome.result, 200);
  assert.strictEqual(outcome.builds, 1);
  assert.strictEqual(outcome.releases, 1);
};

/**
 * Admits the sign-in through the layer that `layerOf` makes of the scope, and checks that the `SqlClient` the scope
 * exposes is the counted layer's: it answers as the full role, where a second database layer made from `env` answers as
 * the restricted one (Effect shares a second `DatabaseLive`'s repositories with the first, but its `SqlClient` is its
 * own, and a later provider wins in a merged context).
 */
const admittedThrough = (
  layerOf: (
    env: WorkerEnv,
    database: Layer.Layer<DatabaseServices>
  ) => Layer.Layer<Auth | SqlClient>
) =>
  Effect.gen(function* checkScope() {
    const full = yield* TestDatabaseUrl;

    const outcome = yield* inScope((env, database) =>
      Effect.gen(function* signInAndAsk() {
        const status = yield* statusOf();
        const sql = yield* SqlClient;

        const rows = yield* sql<{
          readonly name: string;
        }>`select current_user as name`;

        return { role: rows[0]?.name, status };
      }).pipe(Effect.provide(layerOf(env, database)), Effect.orDie)
    );

    const expected = yield* withClient(
      full,
      (client) => client<{ readonly name: string }>`select current_user as name`
    );

    assert.strictEqual(outcome.result.role, expected[0]?.name);
    assert.notStrictEqual(outcome.result.role, undefined);

    oneBuildAndAdmitted({ ...outcome, result: outcome.result.status });
  });

layer(seeded, { excludeTestServices: true })(
  "spec 0017 falsifier 7: one database layer per scope, and Better Auth reads through it",
  (it) => {
    it.effect("deliveryLayer", () =>
      admittedThrough((env, database) => deliveryLayer(env, database))
    );

    it.effect("liveRequestLayer", () =>
      admittedThrough((env, database) =>
        liveRequestLayer(
          {
            ctx: { waitUntil: () => {} },
            env,
            headers: new Headers(),
            signal: new AbortController().signal,
            testActor: undefined,
          },
          database
        )
      )
    );

    it.effect("runSignInPerson", () =>
      Effect.map(
        inScope((env, database) =>
          Effect.map(
            Effect.promise(
              async () =>
                await runSignInPerson(
                  env,
                  {
                    headers: new Headers({
                      origin: SITE,
                      "user-agent": "scope-client",
                    }),
                    password: fixturePassword,
                    personId: PersonId.make(PERSON),
                  },
                  new AbortController().signal,
                  database
                )
            ),
            (response) => response.status
          )
        ),
        oneBuildAndAdmitted
      )
    );

    it.effect("runAuthRequest", () =>
      Effect.map(
        inScope((env, database) =>
          Effect.map(
            Effect.promise(
              async () => await runAuthRequest(signInRequest(), env, database)
            ),
            (response) => response.status
          )
        ),
        oneBuildAndAdmitted
      )
    );

    it.effect(
      "control: a second database layer built from `env` for Better Auth's reads is refused, so the sign-in fails",
      () =>
        Effect.gen(function* hiddenBuild() {
          const restricted = yield* AuthTablesDatabaseUrl;
          const env = workerEnv(Redacted.value(restricted));

          const exit = yield* statusOf().pipe(
            Effect.provide(
              authLayer(env).pipe(
                Layer.orDie,
                Layer.provide(
                  DatabaseLive({ maxConnections: 2, url: restricted })
                )
              )
            ),
            Effect.exit
          );

          assert.isFalse(Exit.isSuccess(exit) && exit.value === 200);
        })
    );

    it.effect(
      "control: a second counted layer provided by value is a second build, and the counter sees it",
      () =>
        Effect.gen(function* twoBuilds() {
          const url = yield* TestDatabaseUrl;
          const builds = yield* Ref.make(0);
          const releases = yield* Ref.make(0);
          const database = counted(url, builds, releases);

          yield* Layer.build(
            Layer.merge(
              deliveryLayer(workerEnv(Redacted.value(url)), database),
              Layer.fresh(database)
            )
          ).pipe(Effect.scoped);

          assert.strictEqual(yield* Ref.get(builds), 2);
          assert.strictEqual(yield* Ref.get(releases), 2);
        })
    );
  }
);
