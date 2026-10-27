/** The typed errors of the test harness, in one place. */
import { Schema } from "effect";

/** The engine's files could not be read. */
export class EngineStorageUnreadable extends Schema.TaggedError<
  EngineStorageUnreadable,
  { readonly brand: unique symbol }
>()("EngineStorageUnreadable", {
  file: Schema.String,
  reason: Schema.String,
}) {}

/** Processes that a runtime owned are still alive after the moment they were supposed to be gone. */
export class OrphanedProcesses extends Schema.TaggedError<
  OrphanedProcesses,
  { readonly brand: unique symbol }
>()("OrphanedProcesses", {
  survivors: Schema.Array(
    Schema.Struct({ command: Schema.String, pid: Schema.Finite })
  ),
}) {}

/** The runtime did not reach the state the harness waits for. */
export class RuntimeNotReady extends Schema.TaggedError<
  RuntimeNotReady,
  { readonly brand: unique symbol }
>()("RuntimeNotReady", { reason: Schema.String }) {}

/** A request to the Worker answered with a status the harness did not expect. */
export class UnexpectedResponse extends Schema.TaggedError<
  UnexpectedResponse,
  { readonly brand: unique symbol }
>()("UnexpectedResponse", { path: Schema.String, status: Schema.Finite }) {}

/** The Cloudflare CLI exited non-zero: `args` are its first words (never a payload), `stderr` is redacted of ids. */
export class CfFailed extends Schema.TaggedError<
  CfFailed,
  { readonly brand: unique symbol }
>()("CfFailed", {
  args: Schema.String,
  code: Schema.Finite,
  stderr: Schema.String,
}) {}

/** The Workflows API answered with a body the harness cannot read. */
export class UnreadableApiBody extends Schema.TaggedError<
  UnreadableApiBody,
  { readonly brand: unique symbol }
>()("UnreadableApiBody", { args: Schema.String, reason: Schema.String }) {}
