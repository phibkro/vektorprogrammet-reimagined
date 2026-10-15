/**
 * The one table that maps the domain's closed error set (plus the web's own
 * `RateLimited`) to HTTP statuses. Every server function, server route and
 * loader goes through `failureOf`; nothing else chooses a status for a typed
 * failure. Defects are not in this table: the runtime logs them and answers
 * 500.
 */
import {
  AlreadyExists,
  Forbidden,
  NotFound,
  ValidationFailed,
  type DomainError,
} from "@vektorprogrammet/domain";
import { Schema } from "effect";
import type { Failure, Outcome } from "../lib/outcome";

/** `/kontakt` per-IP limit exceeded (Cloudflare Rate Limiting binding). */
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {}) {}

export type RequestError = DomainError | RateLimited;

export const RequestErrorSchema = Schema.Union([
  NotFound,
  Forbidden,
  AlreadyExists,
  ValidationFailed,
  RateLimited,
]);

/** The serializable (plain-object) form sent to the browser. */
export type EncodedRequestError = typeof RequestErrorSchema.Encoded;
export type RequestErrorTag = RequestError["_tag"];

/**
 * `status`: server functions, server routes and pages.
 * `formStatus`: a no-JavaScript form post that re-renders the form
 * (spec §3: 422 for validation errors).
 */
export const ERROR_TABLE = {
  NotFound: { status: 404, formStatus: 404 },
  Forbidden: { status: 403, formStatus: 403 },
  AlreadyExists: { status: 409, formStatus: 409 },
  ValidationFailed: { status: 400, formStatus: 422 },
  RateLimited: { status: 429, formStatus: 429 },
} as const satisfies {
  readonly [Tag in RequestErrorTag]: { readonly status: number; readonly formStatus: number };
};

const encode = Schema.encodeSync(RequestErrorSchema);

/** User-facing Norwegian text for a failure (the domain's own text where it has one). */
const messageOf = (error: EncodedRequestError): string => {
  switch (error._tag) {
    case "NotFound":
      return "Fant ikke siden eller elementet.";
    case "Forbidden":
      return "Du har ikke tilgang til dette.";
    case "AlreadyExists":
      return error.message;
    case "ValidationFailed":
      return error.issues.map((issue) => issue.message).join(" ");
    case "RateLimited":
      return "For mange forsøk. Vent litt og prøv igjen.";
  }
};

/** Maps a typed failure through the table into a serializable `Failure`. */
export const failureOf = (error: RequestError): Failure => {
  const encoded = encode(error);
  const row = ERROR_TABLE[encoded._tag];
  return {
    _tag: "Failure",
    status: row.status,
    formStatus: row.formStatus,
    message: messageOf(encoded),
    error: encoded,
  };
};

export const success = <A>(value: A): Outcome<A> => ({ _tag: "Success", value });
