/** Typed request failures shared by server response mapping and browser outcomes. */
import { Schema } from "effect";

import {
  AlreadyExists,
  Conflict,
  Forbidden,
  NotFound,
  ValidationFailed,
} from "../core/errors";
import type { DomainError } from "../core/errors";
import {
  CmsInvalidContent,
  CmsRejected,
  CmsUnavailable,
} from "../features/cms/domain/client";
import type { CmsFailure } from "../features/cms/domain/client";

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
  Conflict,
  ValidationFailed,
  RateLimited,
  CmsUnavailable,
  CmsRejected,
  CmsInvalidContent,
]);

/** The serializable plain-object form sent to the browser. */
export type EncodedRequestError = typeof RequestErrorSchema.Encoded;

export type RequestErrorTag = RequestError["_tag"];
