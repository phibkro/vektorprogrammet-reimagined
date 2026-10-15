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

export class InTransaction extends Context.Service<
  InTransaction,
  { readonly kind: "database-transaction" }
>()("@vektorprogrammet/domain/shared/InTransaction") {}
