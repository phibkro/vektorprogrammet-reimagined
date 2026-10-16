import { Schema } from "effect";

/** A request that produced no usable answer: the message becomes the failing line's evidence. */
export class RequestRefused extends Schema.TaggedError<
  RequestRefused,
  { readonly brand: unique symbol }
>()("RequestRefused", {
  message: Schema.String,
}) {}
