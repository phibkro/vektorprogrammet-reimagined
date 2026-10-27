/**
 * Proof that a command runs inside a database transaction.
 *
 * Commands never open a transaction; they *require* `InTransaction`, so a
 * command that is not wrapped does not type-check. Only `packages/db`'s
 * transaction runner provides it (it wraps the program in
 * `SqlClient.withTransaction` and provides this service inside), and test
 * compositions provide it for in-memory layers. See `src/README.md`.
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
