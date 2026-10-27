/**
 * The typed errors of the spike, in one place. Every one carries identifiers and fixed words only, never a value that
 * came from a person: the workflow engine stores a failure's fields in its own files.
 */
import { Schema } from "effect";

import { RenewalIdSchema } from "./renewal.ts";

/** `DATABASE_URL` names a database that is not on this machine. */
export class NonLocalDatabase extends Schema.TaggedError<
  NonLocalDatabase,
  { readonly brand: unique symbol }
>()("NonLocalDatabase", { host: Schema.String }) {}

/** The stack was planned for a deployment, which this spike does not declare. */
export class DevOnly extends Schema.TaggedError<
  DevOnly,
  { readonly brand: unique symbol }
>()("DevOnly", { message: Schema.String }) {}

/** The platform's tables are missing: the test or admin setup did not run `migrate`. A defect, never retried. */
export class PlatformTablesMissing extends Schema.TaggedError<
  PlatformTablesMissing,
  { readonly brand: unique symbol }
>()("PlatformTablesMissing", {
  message: Schema.String,
  table: Schema.String,
}) {}

/** A task attempt failed in a way another attempt may not. The native retry sends the same command again. */
export class TransientFailure extends Schema.TaggedError<
  TransientFailure,
  { readonly brand: unique symbol }
>()("TransientFailure", { attempt: Schema.Int, renewalId: RenewalIdSchema }) {}
