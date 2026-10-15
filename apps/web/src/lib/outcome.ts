/**
 * The serializable result of a server function, safe to import from client
 * components (type-only dependency on the server's error table).
 */
import { notFound } from "@tanstack/react-router";
import type { EncodedRequestError } from "../server/errors";

export type Failure = {
  readonly _tag: "Failure";
  readonly status: number;
  readonly formStatus: number;
  readonly message: string;
  readonly error: EncodedRequestError;
};

export type Outcome<A> = { readonly _tag: "Success"; readonly value: A } | Failure;

/** Field → messages, for forms (empty unless the failure is `ValidationFailed`). */
export const fieldErrors = (
  outcome: Outcome<unknown> | null | undefined,
): Readonly<Record<string, ReadonlyArray<string>>> => {
  if (!outcome || outcome._tag === "Success" || outcome.error._tag !== "ValidationFailed") {
    return {};
  }
  const fields: Record<string, Array<string>> = {};
  for (const issue of outcome.error.issues) {
    const key = issue.path.join(".");
    (fields[key] ??= []).push(issue.message);
  }
  return fields;
};

/** Thrown by a loader for a failure other than 404; the route's error component shows `message`. */
export class PageFailure extends Error {
  readonly status: number;
  constructor(failure: Failure) {
    super(failure.message);
    this.name = "PageFailure";
    this.status = failure.status;
  }
}

/**
 * The route-loader rule: a page's data, or TanStack's `notFound()` for a 404
 * (e.g. a draft article, RULE-267), or a `PageFailure` for any other failure.
 */
export const pageData = <A>(outcome: Outcome<A>): A => {
  if (outcome._tag === "Success") return outcome.value;
  if (outcome.status === 404) throw notFound();
  throw new PageFailure(outcome);
};
