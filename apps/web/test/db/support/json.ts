/** A value as JSON text, for a test that looks for a string in it or writes it as a jsonb column. */
import { Schema } from "effect";

export const encodeJson = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Unknown)
);
