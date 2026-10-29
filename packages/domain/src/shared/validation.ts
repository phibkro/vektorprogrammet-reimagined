/**
 * Input decoding for commands: one decoder per input schema, failures mapped to
 * `ValidationFailed` with every issue (`errors: "all"`), so a form can show all
 * field messages at once.
 */
import {
  Array as Arr,
  Effect,
  Predicate,
  Schema,
  SchemaIssue,
  String as Str,
} from "effect";
import { isReadonlyArrayNonEmpty } from "effect/Array";

import { validationFailedWith } from "./errors.ts";
import type { ValidationFailed, ValidationIssue } from "./errors.ts";

/** Legacy message for a required field (sic, "Feletet" as in the legacy UI). */
export const REQUIRED_FIELD_MESSAGE = "Feletet kan ikke være tomt.";

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

const pathSegment = (
  segment: PropertyKey | { readonly key: PropertyKey }
): string =>
  Predicate.isObject(segment) ? String(segment.key) : String(segment);

export const fromSchemaError = (
  error: Schema.SchemaError
): ValidationFailed => {
  const issues: ValidationIssue[] = Arr.map(
    formatter(error.issue).issues,
    (issue) => ({
      message: issue.message,
      path: Arr.map(issue.path ?? [], pathSegment),
    })
  );

  return isReadonlyArrayNonEmpty(issues)
    ? validationFailedWith(issues)
    : validationFailedWith([{ message: "Ugyldig input.", path: [] }]);
};

/** Builds a reusable decoder from `unknown` input to the schema's type. */
export const decodeInput = <S extends Schema.Constraint>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(schema, { errors: "all" });

  return (
    input: unknown
  ): Effect.Effect<S["Type"], ValidationFailed, S["DecodingServices"]> =>
    decode(input).pipe(Effect.mapError(fromSchemaError));
};

/** Trimmed, non-blank text with an optional maximum length. */
export const requiredText = (options?: {
  readonly maxLength?: number;
  readonly message?: string;
}) => {
  const message = options?.message ?? REQUIRED_FIELD_MESSAGE;

  const target =
    options?.maxLength === undefined
      ? Schema.String.check(Schema.isNonEmpty({ message }))
      : Schema.String.check(
          Schema.isNonEmpty({ message }),
          Schema.isMaxLength(options.maxLength, {
            message: `Maks ${options.maxLength} tegn.`,
          })
        );

  return Schema.Trim.pipe(Schema.decodeTo(target));
};

/** A single-line e-mail check: something@something.tld, no whitespace. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?<domainSegment>\.[^\s@.]+)+$/u;

export const INVALID_EMAIL_MESSAGE = "Ugyldig e-postadresse.";

export const EmailAddress = Schema.String.check(
  Schema.isPattern(EMAIL_PATTERN, { message: INVALID_EMAIL_MESSAGE })
).pipe(Schema.brand("EmailAddress"));

export type EmailAddress = typeof EmailAddress.Type;

/** Form input for an e-mail address: trimmed, then checked. */
export const EmailAddressInput = Schema.Trim.pipe(
  Schema.decodeTo(EmailAddress)
);

export const INVALID_URL_MESSAGE =
  "Ugyldig nettadresse. Bruk en adresse som starter med http:// eller https://.";

const isHttpUrl = (value: string): boolean => {
  if (!URL.canParse(value)) {
    return false;
  }

  const url = new URL(value);

  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    Str.includes(".")(url.hostname)
  );
};

/** An absolute http(s) URL with a dotted host name. */
export const HttpUrl = Schema.String.check(
  Schema.makeFilter(isHttpUrl, { message: INVALID_URL_MESSAGE })
).pipe(Schema.brand("HttpUrl"));

export type HttpUrl = typeof HttpUrl.Type;
