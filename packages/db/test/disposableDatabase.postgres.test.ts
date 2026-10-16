/**
 * A disposable database is dropped when its scope closes, however long the scope lived. Its release once
 * waited on an admin pool built at the start: the pool retires a connection it finds idle for 60 to 120
 * seconds and cannot open another while its scope is closing, so a run longer than two minutes (the browser
 * tests in CI) never finished. `TestClock` supplies the minutes: a pool built on it retires its connection when
 * the test moves the clock, so the old release hangs here as well.
 */
import { assert, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect";
import type { Redacted } from "effect";
import { TestClock } from "effect/testing";

import {
  migratedTestDatabase,
  TestDatabaseUrl,
  withClient,
} from "./support/disposableDatabase.ts";

/** Whether the server lets a client in and answers it. */
const connects = (url: Redacted.Redacted) =>
  Effect.exit(
    withClient(url, (client) => client.unsafe("select 1 as present"))
  );

it.effect(
  "drops the database when its scope closes, however long it lived",
  () =>
    Effect.gen(function* releaseAfterTheIdleWindowEffect() {
      const scope = yield* Scope.make();
      const services = yield* Layer.buildWithScope(migratedTestDatabase, scope);
      const url = Context.get(services, TestDatabaseUrl);

      assert.isTrue(Exit.isSuccess(yield* connects(url)));

      yield* TestClock.adjust("5 minutes");
      yield* Scope.close(scope, Exit.void);

      const afterwards = yield* connects(url);

      assert.isTrue(Exit.isFailure(afterwards));

      if (Exit.isFailure(afterwards)) {
        assert.include(Cause.pretty(afterwards.cause), "does not exist");
      }
    })
);
