/**
 * The only provider of the domain's `InTransaction`.
 *
 * Runs `self` in `SqlClient.withTransaction` (a savepoint when already inside
 * one) with `InTransaction` provided. A typed failure, a defect or an
 * interruption rolls back every row the program wrote: domain rows, the audit
 * row and the outbox rows. A failing BEGIN or COMMIT is an infrastructure
 * failure and therefore a defect.
 *
 * Receipt: success means committed. No provider I/O may run inside `self`.
 */
import { InTransaction } from "@vektorprogrammet/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/sql/SqlError";

const inTransaction = InTransaction.of({ kind: "database-transaction" });

export const transactional = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, SqlError>, Exclude<R, InTransaction> | SqlClient> =>
  SqlClient.pipe(
    Effect.flatMap((sql) =>
      sql.withTransaction(Effect.provideService(self, InTransaction, inTransaction)),
    ),
    Effect.catchIf<E | SqlError, SqlError, never, never, never>(isSqlError, (error) =>
      Effect.die(error),
    ),
  );
