import {
  CmsInvalidContent,
  CmsRejected,
  CmsUnavailable,
} from "@vektorprogrammet/cms-client";
import type { CmsFailure } from "@vektorprogrammet/cms-client";
/**
 * The one table that maps the domain's closed error set (plus the web's own
 * `RateLimited` and the CMS client's three failures) to HTTP statuses. Every server function, server route and
 * loader goes through `failureOf`; nothing else chooses a status for a typed
 * failure. Defects are not in this table: the runtime logs them and answers
 * 500. A CMS that cannot be reached is a 503, and one that refuses or sends content that does not match
 * its collection is a 502: the page is the web's, the failure is upstream.
 */
import {
  AlreadyExists,
  Forbidden,
  NotFound,
  ValidationFailed,
} from "@vektorprogrammet/domain";
import type { DomainError } from "@vektorprogrammet/domain";
import { Array as Arr, Match, Schema } from "effect";

import { failureOutcome } from "../lib/outcome";
import type { Failure } from "../lib/outcome";

/** `/kontakt` per-IP limit exceeded (Cloudflare Rate Limiting binding). */
export class RateLimited extends Schema.TaggedError<
  RateLimited,
  { readonly brand: unique symbol }
>()("RateLimited", {}) {}

export type RequestError = DomainError | RateLimited | CmsFailure;

export const RequestErrorSchema = Schema.Union([
  NotFound,
  Forbidden,
  AlreadyExists,
  ValidationFailed,
  RateLimited,
  CmsUnavailable,
  CmsRejected,
  CmsInvalidContent,
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
  AlreadyExists: { formStatus: 409, status: 409 },
  CmsInvalidContent: { formStatus: 502, status: 502 },
  CmsRejected: { formStatus: 502, status: 502 },
  CmsUnavailable: { formStatus: 503, status: 503 },
  Forbidden: { formStatus: 403, status: 403 },
  NotFound: { formStatus: 404, status: 404 },
  RateLimited: { formStatus: 429, status: 429 },
  ValidationFailed: { formStatus: 422, status: 400 },
} as const satisfies {
  readonly [Tag in RequestErrorTag]: {
    readonly status: number;
    readonly formStatus: number;
  };
};

const encode = Schema.encodeSync(RequestErrorSchema);

/** User-facing Norwegian text for a failure (the domain's own text where it has one). */
const messageOf = (error: EncodedRequestError): string =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      AlreadyExists: (failure) => failure.message,
      CmsInvalidContent: () =>
        "Innholdet på siden er ugyldig. Prøv igjen senere.",
      CmsRejected: () =>
        "Innholdstjenesten avviste forespørselen. Prøv igjen senere.",
      CmsUnavailable: () =>
        "Innholdet er midlertidig utilgjengelig. Prøv igjen om litt.",
      Forbidden: () => "Du har ikke tilgang til dette.",
      NotFound: () => "Fant ikke siden eller elementet.",
      RateLimited: () => "For mange forsøk. Vent litt og prøv igjen.",
      ValidationFailed: (failure) =>
        Arr.join(
          Arr.map(failure.issues, (issue) => issue.message),
          " "
        ),
    })
  );

/** Maps a typed failure through the table into a serializable `Failure`. */
export const failureOf = (error: RequestError): Failure => {
  const encoded = encode(error);
  const row = ERROR_TABLE[encoded._tag];

  return failureOutcome({
    error: encoded,
    formStatus: row.formStatus,
    message: messageOf(encoded),
    status: row.status,
  });
};

export { success } from "../lib/outcome";
