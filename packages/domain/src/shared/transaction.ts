/**
 * Proof that a program runs inside a transaction of the store.
 *
 * Commands never open a transaction; they *require* `InTransaction`, so a command that is not wrapped does not
 * type-check. Only a `Transactor` provides it (`packages/db`'s runner for PostgreSQL, and the test compositions over
 * in-memory layers). See `src/README.md`.
 *
 * What the proof promises (spec 0018; the guarantees are declared in `guarantees.ts`):
 * - TX1: everything written under it becomes visible together or not at all; a typed failure, a defect or an
 *   interruption leaves nothing; `run` succeeding means committed.
 * - TX2: a nested scope undoes only its own writes and releases only its own locks.
 * - TX3, the isolation floor ReadCommittedWithLocks: no read sees another transaction's uncommitted write, and a read
 *   made after a lock on a record returns the record as of the grant of the lock or later. Nothing is promised across
 *   two reads of unlocked records: a program that needs one state reads it in one call or locks. A stronger isolation
 *   level satisfies it and is allowed.
 * - TX4: a deadlock or a serialization failure is a defect and is never retried.
 * - TX5: only a `Transactor` (or a test composition that keeps TX1 to TX3) provides it.
 */
import { Context } from "effect";

/**
 * A repository method that writes a table that an aggregate owns (spec 0006b) requires it too, because the lock
 * that the write needs lasts only as long as the transaction. That is a requirement of the caller's, not an
 * implementation detail of the repository, so the service is marked leakable.
 *
 * @effect-leakable-service
 */
export class InTransaction extends Context.Service<
  InTransaction,
  { readonly kind: "database-transaction" }
>()("@vektorprogrammet/domain/shared/InTransaction") {}
