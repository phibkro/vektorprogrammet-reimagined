/**
 * The adapter of `IsolationProbe` (declared by the domain, spec 0018 R10): the isolation levels that this store reports,
 * read from the store itself, as a deployed check needs them.
 *
 * - `transactor` is read through the domain's `Transactor`, the same runner that every command uses.
 * - `probe` is read in a transaction that begins at SERIALIZABLE through `SqlClient.BeginTransaction`, the mechanism
 *   that `transactional` uses for READ COMMITTED. A pooler that drops the clause makes it read the role's default, so
 *   the report tells a clause that arrived from a default that happens to match. The transaction reads one setting and
 *   writes nothing.
 * - `roleDefault` is read outside any transaction.
 *
 * A failing statement is a defect, as in `transactional`: a store that cannot answer is not a store that reports a level.
 */
import { IsolationProbe, Transactor } from "@vektorprogrammet/domain";
import { Effect, Layer } from "effect";
import { BeginTransaction, SqlClient } from "effect/sql/SqlClient";

/** The probe's own `BEGIN`: the same mechanism as `atReadCommitted`, at the one level that is not the floor. */
const BEGIN_SERIALIZABLE = "BEGIN ISOLATION LEVEL SERIALIZABLE";

export const IsolationProbeLive = Layer.effect(
  IsolationProbe,
  Effect.gen(function* IsolationProbeLive() {
    const sql = yield* SqlClient;
    const transactor = yield* Transactor;

    const levelOf = (setting: string) =>
      Effect.map(
        sql<{
          readonly level: string;
        }>`select current_setting(${setting}) as level`,
        (rows) => rows[0]?.level ?? "no answer"
      );

    return IsolationProbe.of({
      report: Effect.gen(function* reportLevels() {
        const inTransactor = yield* transactor.run(
          levelOf("transaction_isolation")
        );

        const inProbe = yield* sql
          .withTransaction(levelOf("transaction_isolation"))
          .pipe(Effect.provideService(BeginTransaction, BEGIN_SERIALIZABLE));

        const outside = yield* levelOf("default_transaction_isolation");

        return {
          probe: inProbe,
          roleDefault: outside,
          transactor: inTransactor,
        };
      }).pipe(Effect.orDie),
    });
  })
);
