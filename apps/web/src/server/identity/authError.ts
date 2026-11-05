import { Schema } from "effect";

/** An auth boundary could not obtain or persist its result; the original cause is retained for diagnosis. */
export class AuthBoundaryFailure extends Schema.TaggedError<
  AuthBoundaryFailure,
  { readonly brand: unique symbol }
>()("AuthBoundaryFailure", { cause: Schema.Defect() }) {}
