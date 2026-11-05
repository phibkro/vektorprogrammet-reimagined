import { Schema } from "effect";

/** The platform evidence required by both local and hosted browser verification. */
export const Platform = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({ held: Schema.Boolean, id: Schema.String })
  ),
  deployment: Schema.String,
  problems: Schema.Array(Schema.String),
  profile: Schema.String,
});
