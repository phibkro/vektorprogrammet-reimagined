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
 * - TX5: only a `Transactor`, or a test composition that keeps TX1 to TX3, provides it, and a store adapter refuses a
 *   proof that is not the live transaction's own, at first use (spec 0019).
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

/** The key of the marker that an integration port carries. It exists only in types: no value has it at run time. */
export const IntegrationTypeId = "~@vektorprogrammet/domain/IntegrationPort";

export type IntegrationTypeId = typeof IntegrationTypeId;

/**
 * A service that reaches another system, with its own state and rules, outside our transaction: mail, Slack, Turnstile,
 * the Google Workspace directory (ADR 0015, section 10). Rule 1 of that category: no integration call inside a
 * transaction. A port declares it by writing, in its class body, `declare readonly [IntegrationTypeId]:
 * IntegrationTypeId` and `implements IntegrationPort`; the property is a phantom, so the Layer that provides the port
 * is unchanged. `Transactor.run` takes only programs whose requirements are `NotAnIntegration`, so a call that could
 * hold a transaction open while a provider answers, or that a rollback cannot take back, does not type-check
 * (falsifier F11, spec 0020). Run it before the transaction opens or after it has committed.
 */
export interface IntegrationPort {
  readonly [IntegrationTypeId]: IntegrationTypeId;
}

/**
 * What `Transactor.run` allows a program to require: a service that is not an integration port, since an unmarked
 * service has no `[IntegrationTypeId]`. Intersected with `object` because a type whose properties are all optional is
 * "weak", and TypeScript then refuses a source that shares no property with it (every service that is not a port).
 * A function that passes a program to `Transactor.run` for a requirement `R` of its own constrains `R` the same way.
 */
export type NotAnIntegration = object & {
  readonly [IntegrationTypeId]?: never;
};
