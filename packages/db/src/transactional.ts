/**
 * The only provider of the domain's `InTransaction`.
 *
 * Runs `self` in `SqlClient.withTransaction` (a savepoint when already inside
 * one) with `InTransaction` provided. A typed failure, a defect or an
 * interruption rolls back every row the program wrote: domain rows, the audit
 * row and the outbox rows. A failing BEGIN or COMMIT is an infrastructure
 * failure and therefore a defect.
 *
 * Each level also opens the scope of the aggregate locks it takes (`aggregate/lockScope.ts`). A level that fails
 * drops its locks, as PostgreSQL releases the row locks of a rolled-back savepoint; a level that succeeds hands them
 * to the level around it.
 *
 * Receipt: success means committed. No provider I/O may run inside `self`.
 */
import { InTransaction } from "@vektorprogrammet/domain";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import type { SqlError } from "effect/sql/SqlError";

import { CurrentLockScope, handUp, openScope } from "./aggregate/lockScope.ts";

const inTransaction = InTransaction.of({ kind: "database-transaction" });

const withLockScope = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* lockScopeLevel() {
    const scope = yield* openScope(yield* CurrentLockScope);

    const result = yield* Effect.provideService(
      self,
      CurrentLockScope,
      Option.some(scope)
    );

    yield* handUp(scope);

    return result;
  });

export const transactional = <A, E, R>(
  self: Effect.Effect<A, E, R>
): Effect.Effect<
  A,
  Exclude<E, SqlError>,
  Exclude<R, InTransaction> | SqlClient
> =>
  SqlClient.pipe(
    Effect.flatMap((sql) =>
      sql.withTransaction(
        withLockScope(Effect.provideService(self, InTransaction, inTransaction))
      )
    ),
    Effect.catchIf<E | SqlError, SqlError, never, never, never>(
      isSqlError,
      (error) => Effect.die(error)
    )
  );
