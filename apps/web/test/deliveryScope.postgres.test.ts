/**
 * Spec 0017, falsifier 7: a delivery scope builds its database layer once. Better Auth asks the domain through the same
 * `DatabaseLive` that serves the senders and the repositories, so a second pool is not opened for it. The probe counts
 * the builds and the releases of the database layer that the scope is given; the control is the plausible bug, a second
 * layer provided by value, which the same counter sees as a second build.
 */
import { assert, layer } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
} from "@vektorprogrammet/db/testing";
import { Effect, Layer, Redacted, Ref } from "effect";
import type { Redacted as RedactedType } from "effect";

import { deliveryLayer } from "../src/server/runtime";
import type { TickEnv } from "../src/server/runtime";

const envFor = (url: RedactedType.Redacted): TickEnv => ({
  BETTER_AUTH_SECRET: "local-fake-signing-secret-only-123456789",
  DEPLOYMENT: "local",
  HYPERDRIVE: { connectionString: Redacted.value(url) },
  SITE_URL: "https://scope.example",
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

layer(migratedTestDatabase.pipe(Layer.orDie), { excludeTestServices: true })(
  "spec 0017 falsifier 7: one database layer per scope",
  (it) => {
    it.effect(
      "the delivery scope builds its database layer once and releases it once, with Better Auth over it",
      () =>
        Effect.gen(function* oneBuild() {
          const url = yield* TestDatabaseUrl;
          const builds = yield* Ref.make(0);
          const releases = yield* Ref.make(0);

          yield* Layer.build(
            deliveryLayer(envFor(url), counted(url, builds, releases))
          ).pipe(Effect.scoped);

          assert.strictEqual(yield* Ref.get(builds), 1);
          assert.strictEqual(yield* Ref.get(releases), 1);
        })
    );

    it.effect(
      "control: a second database layer provided by value is a second build, and the counter sees it",
      () =>
        Effect.gen(function* twoBuilds() {
          const url = yield* TestDatabaseUrl;
          const builds = yield* Ref.make(0);
          const releases = yield* Ref.make(0);
          const database = counted(url, builds, releases);

          yield* Layer.build(
            Layer.merge(
              deliveryLayer(envFor(url), database),
              Layer.fresh(database)
            )
          ).pipe(Effect.scoped);

          assert.strictEqual(yield* Ref.get(builds), 2);
          assert.strictEqual(yield* Ref.get(releases), 2);
        })
    );
  }
);
