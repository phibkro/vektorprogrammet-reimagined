/**
 * What a deployed store reports about the isolation of its transactions (spec 0018 R10, review round 1, findings 4 and
 * 5). The guarantee is TX3 (`guarantees.ts`): `InTransaction` promises ReadCommittedWithLocks, and the adapter begins
 * its transactions at READ COMMITTED by name. A deployment reaches its store through a pooler, and what the pooler does
 * with the clause is a fact of the platform: the level of a transaction there can only be read from the store itself.
 *
 * The report holds three levels, each as the store names it (`read committed`, `serializable`):
 *
 * - `transactor`: the level that a program run by `Transactor.run` reads inside its transaction.
 * - `probe`: the level that a transaction begun at SERIALIZABLE through the same mechanism reads. If the platform
 *   drops the clause, this reads the role's default, so the report can tell "the clause arrived" from "the default
 *   happens to be the level that was asked for".
 * - `roleDefault`: the level a statement outside a transaction runs at (the `Standalone` and `Joins` methods used
 *   alone). Those are not pinned, so the default is asserted instead.
 *
 * The port reports, and a composition root decides what it expects. It opens its own transactions and takes none
 * (`TransactionModes`: `Opens`), and the store adapter keeps the engine's words.
 */
import { Context } from "effect";
import type { Effect } from "effect";

export interface IsolationReport {
  readonly transactor: string;
  readonly probe: string;
  readonly roleDefault: string;
}

export class IsolationProbe extends Context.Service<
  IsolationProbe,
  { readonly report: Effect.Effect<IsolationReport> }
>()("@vektorprogrammet/domain/shared/IsolationProbe") {}
