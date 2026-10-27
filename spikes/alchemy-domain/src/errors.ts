import { Schema } from "effect";

/** An instance changed between the read and the write although nobody held its lock: a bug, never a rejection. */
export class StaleInstance extends Schema.TaggedError<
  StaleInstance,
  { readonly brand: unique symbol }
>()("StaleInstance", {
  aggregate: Schema.String,
  expected: Schema.Int,
  id: Schema.String,
}) {}
