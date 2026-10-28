/**
 * Proof that a program runs inside a transaction of the store.
 *
 * Commands never open a transaction; they *require* `InTransaction`, so a command that is not wrapped does not
 * type-check. Only a `Transactor` provides it (the store adapter's runner in `packages/db`, and the test compositions
 * over in-memory layers). See `src/README.md`.
 *
 * What the proof promises is declared in `guarantees.ts` (spec 0018) and rendered in `docs/system/store-guarantees.md`;
 * this comment cites it by id and does not restate it:
 * - TX1: one commit for everything written under it (or nothing).
 * - TX2: a nested scope undoes and releases only its own.
 * - TX3: the isolation floor, ReadCommittedWithLocks (a stronger level is allowed).
 * - TX4: a deadlock or a serialization failure is a defect, never retried.
 * - TX5: only a `Transactor`, or a test composition that keeps TX1 to TX3, provides it. (A source test catches a second
 *   provider by accident; Effect keys a service by a string, so it cannot stop a deliberate forgery: spec 0018 R20.)
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
