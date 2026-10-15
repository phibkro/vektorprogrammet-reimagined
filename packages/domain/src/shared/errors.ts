/**
 * The closed set of typed domain errors. Every command and query fails only with
 * these; infrastructure failures (lost connection, driver bugs) are defects.
 *
 * | Error            | HTTP (mapped once in `apps/web`) |
 * |------------------|----------------------------------|
 * | NotFound         | 404                              |
 * | Forbidden        | 403                              |
 * | AlreadyExists    | 409                              |
 * | ValidationFailed | 400 / 422 (form re-render)        |
 */
import { Schema } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { EntityName } from "./ids.ts";

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  entity: EntityName,
  key: Schema.String,
}) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  /** The `_tag` of the capability the actor lacked. */
  capability: Schema.String,
}) {}

export class AlreadyExists extends Schema.TaggedError<AlreadyExists>()("AlreadyExists", {
  entity: EntityName,
  key: Schema.String,
  /** User-facing Norwegian text. */
  message: Schema.String,
}) {}

export const ValidationIssue = Schema.Struct({
  path: Schema.Array(Schema.String),
  /** User-facing Norwegian text where the rule defines one. */
  message: Schema.String,
});
export type ValidationIssue = typeof ValidationIssue.Type;

export class ValidationFailed extends Schema.TaggedError<ValidationFailed>()("ValidationFailed", {
  issues: Schema.NonEmptyArray(ValidationIssue),
}) {}

export type DomainError = NotFound | Forbidden | AlreadyExists | ValidationFailed;

/** One issue at one path. */
export const validationFailed = (path: ReadonlyArray<string>, message: string): ValidationFailed =>
  new ValidationFailed({ issues: [{ path: [...path], message }] });

export const validationFailedWith = (
  issues: NonEmptyReadonlyArray<ValidationIssue>,
): ValidationFailed => new ValidationFailed({ issues: [issues[0], ...issues.slice(1)] });
