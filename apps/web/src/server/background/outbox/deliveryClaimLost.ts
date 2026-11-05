import { Schema } from "effect";

/** Internal rollback signal when an outbox claim was replaced during code delivery. */
export class DeliveryClaimLost extends Schema.TaggedError<
  DeliveryClaimLost,
  { readonly brand: unique symbol }
>()("DeliveryClaimLost", {}) {}
