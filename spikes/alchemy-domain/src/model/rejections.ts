/**
 * The refusals of the aggregates: the kernel's closed set of typed errors (`shared/errors.ts`) as
 * `Domain.Rejection`s, tag for tag and field for field. A rejection of an aggregate is data that the command declares;
 * the facade (`facade.ts`) turns each back into the kernel's own error, so the error table of `apps/web` is unchanged.
 */
import * as Domain from "@alchemy.run/domain";
import { EntityName, ValidationIssue } from "@vektorprogrammet/domain";
import { Schema } from "effect";

export class Forbidden extends Domain.Rejection("Forbidden", {
  command: Schema.String,
}) {}

export class NotFound extends Domain.Rejection("NotFound", {
  entity: EntityName,
  key: Schema.String,
}) {}

export class AlreadyExists extends Domain.Rejection("AlreadyExists", {
  entity: EntityName,
  key: Schema.String,
  message: Schema.String,
}) {}

export class Conflict extends Domain.Rejection("Conflict", {
  entity: EntityName,
  key: Schema.String,
  message: Schema.String,
}) {}

export class ValidationFailed extends Domain.Rejection("ValidationFailed", {
  issues: Schema.NonEmptyArray(ValidationIssue),
}) {}

/** One issue at one path, as the kernel's `validationFailed` builds it. */
export const invalid = (path: readonly string[], message: string) =>
  new ValidationFailed({ issues: [{ message, path: [...path] }] });
