/**
 * The only provider of the domain's `InTransaction`.
 *
 * Runs `self` in `SqlClient.withTransaction` (a savepoint when already inside
 * one) with `InTransaction` provided. A typed failure, a defect or an
 * interruption rolls back every row the program wrote: domain rows, the audit
 * row and the outbox rows. A failing BEGIN or COMMIT is an infrastructure
 * failure and therefore a defect.
 *
 * A top-level transaction begins at READ COMMITTED, said in its own `BEGIN` (`SqlClient.BeginTransaction`), so the
 * floor that the domain promises (TX3, ReadCommittedWithLocks) is stated and not the default of the server or the
 * role: a role that defaults to SERIALIZABLE would otherwise make every transaction a level whose serialization
 * failures nobody retries (TX4). A nested level is a savepoint and keeps its parent's level.
 *
 * Each level also opens the scope of the aggregate locks it takes (`aggregate/lockScope.ts`). A level that fails
 * drops its locks, as PostgreSQL releases the row locks of a rolled-back savepoint; a level that succeeds hands them
 * to the level around it.
 *
 * Receipt: success means committed. No provider I/O may run inside `self`.
 */
import { InTransaction, Transactor } from "@vektorprogrammet/domain";
import { Effect, Layer, Option } from "effect";
import { BeginTransaction, SqlClient } from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import type { SqlError } from "effect/sql/SqlError";

import { CurrentLockScope, handUp, openScope } from "./aggregate/lockScope.ts";

/** The statement that a top-level transaction begins with: the isolation floor of `InTransaction`, by name. */
const BEGIN_READ_COMMITTED = "BEGIN ISOLATION LEVEL READ COMMITTED";

/**
 * Makes the transaction that `opens` starts begin at READ COMMITTED, in its own `BEGIN`. `transactional` and the legacy
 * importer's one transaction both open theirs through it, so no transaction of this adapter that holds locks or writes in
 * more than one statement begins at the role's default (spec 0018 R9).
 */
export const atReadCommitted = <A, E, R>(opens: Effect.Effect<A, E, R>) =>
  Effect.provideService(opens, BeginTransaction, BEGIN_READ_COMMITTED);

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
      sql
        .withTransaction(
          withLockScope(
            Effect.provideService(self, InTransaction, inTransaction)
          )
        )
        .pipe(atReadCommitted)
    ),
    Effect.catchIf<E | SqlError, SqlError, never, never, never>(
      isSqlError,
      (error) => Effect.die(error)
    )
  );

/** The domain's `Transactor` over the ambient `SqlClient`: `run` is `transactional`, so it is one transaction. */
export const TransactorLive = Layer.effect(
  Transactor,
  Effect.gen(function* TransactorLive() {
    const sql = yield* SqlClient;

    return Transactor.of({
      run: (program) =>
        transactional(program).pipe(Effect.provideService(SqlClient, sql)),
    });
  })
);
