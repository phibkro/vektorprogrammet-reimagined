/**
 * What the lock construct and the transaction proof treat as a defect (specs 0006b and 0019): a mistake in how a command
 * or a declaration was written, or a proof that was forged. The first run that reaches it finds it, with no race
 * needed, and none of them is recoverable, so none is in a typed error channel.
 */
import { Schema } from "effect";

/** A lock that would break the global order, so that two transactions could wait for each other. */
export class LockOrderViolation extends Schema.TaggedError<
  LockOrderViolation,
  { readonly brand: unique symbol }
>()("LockOrderViolation", {
  message: Schema.String,
}) {}

/** A method that requires `InTransaction` ran without the proof of the transaction that this fiber is in (spec 0019). */
export class TransactionNotLive extends Schema.TaggedError<
  TransactionNotLive,
  { readonly brand: unique symbol }
>()("TransactionNotLive", {
  message: Schema.String,
}) {}

/** A write or a decision read with a token of a lock that this transaction does not hold. */
export class LockNotHeld extends Schema.TaggedError<
  LockNotHeld,
  { readonly brand: unique symbol }
>()("LockNotHeld", {
  message: Schema.String,
}) {}

/** A transition that creates or removes a row, or starts from no state: `apply` changes the state of a row that exists. */
export class TransitionNotApplicable extends Schema.TaggedError<
  TransitionNotApplicable,
  { readonly brand: unique symbol }
>()("TransitionNotApplicable", {
  message: Schema.String,
}) {}

/** A write that sets a column that only the construct writes: the owner's (the token gives it) or a machine's state. */
export class ProtectedColumn extends Schema.TaggedError<
  ProtectedColumn,
  { readonly brand: unique symbol }
>()("ProtectedColumn", {
  message: Schema.String,
}) {}

/** What `declare` found wrong with the data it was given; the closure test and the types keep it from happening. */
export class OwnershipDeclarationError extends Schema.TaggedError<
  OwnershipDeclarationError,
  { readonly brand: unique symbol }
>()("OwnershipDeclarationError", {
  message: Schema.String,
}) {}
