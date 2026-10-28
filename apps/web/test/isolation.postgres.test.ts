/**
 * Spec 0018, falsifier 4, the deployed path: what `GET /api/isolation` answers. On a database whose role defaults to
 * SERIALIZABLE, a preview and a local deployment answer `read committed` (the level that `transactional` begins at, read
 * inside `Transactor.run`); a production deployment has no such route and never reaches the store. The route's reply is the
 * level as text, a 404 on production, and the failure's own status otherwise. The pull request's check
 * (`.github/workflows/preview.yml`) asks the same route of the Worker Preview, through Hyperdrive.
 */
import { assert, layer } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  migratedTestDatabase,
  serializableByDefault,
} from "@vektorprogrammet/db/testing";
import { Forbidden, Transactor } from "@vektorprogrammet/domain";
import { Effect, Layer, Option } from "effect";

import { success } from "../src/lib/outcome";
import { failureOf } from "../src/server/errors";
import {
  isolationResponse,
  transactionIsolation,
} from "../src/server/isolation";

const onSerializableByDefault = Effect.map(serializableByDefault, (url) =>
  DatabaseLive({ maxConnections: 2, url }).pipe(Layer.orDie)
);

/** A `Transactor` that fails the test when it is used: production must never reach the store. */
const untouchable = Transactor.of({
  run: () => Effect.die("a production deployment reached the store"),
});

layer(migratedTestDatabase, { excludeTestServices: true })(
  "GET /api/isolation (spec 0018)",
  (it) => {
    it.effect(
      "falsifier 4: a preview and a local deployment answer read committed on a database that defaults to serializable",
      () =>
        Effect.gen(function* answersReadCommitted() {
          const database = yield* onSerializableByDefault;

          for (const deployment of ["preview", "local"]) {
            const level = yield* transactionIsolation(deployment).pipe(
              Effect.provide(database)
            );

            assert.deepStrictEqual(level, Option.some("read committed"));
          }
        })
    );

    it.effect(
      "falsifier 4: a production deployment answers nothing and never reaches the store",
      () =>
        Effect.gen(function* answersNothing() {
          const database = yield* onSerializableByDefault;

          const level = yield* transactionIsolation("production").pipe(
            Effect.provideService(Transactor, untouchable),
            Effect.provide(database)
          );

          assert.deepStrictEqual(level, Option.none());
        })
    );

    it.effect(
      "falsifier 4: the reply is the level as text, a 404 on production, and the failure's status otherwise",
      () =>
        Effect.gen(function* repliesWithTheLevel() {
          const ok = isolationResponse(success(Option.some("read committed")));
          assert.strictEqual(ok.status, 200);
          assert.strictEqual(
            yield* Effect.promise(() => ok.text()),
            "read committed"
          );

          assert.strictEqual(
            isolationResponse(success(Option.none())).status,
            404
          );

          const refused = isolationResponse(
            failureOf(new Forbidden({ command: "createDepartment" }))
          );

          assert.strictEqual(refused.status, 403);
        })
    );
  }
);
