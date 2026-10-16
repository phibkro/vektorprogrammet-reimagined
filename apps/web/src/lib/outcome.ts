/**
 * The serializable result of a server function, safe to import from client
 * components (type-only dependency on the server's error table).
 */
import { notFound } from "@tanstack/react-router";
import { Array as Arr, Data, Predicate, Record as Rec, Schema } from "effect";

import type { EncodedRequestError } from "../server/errors";

interface FailureFields {
  readonly status: number;
  readonly formStatus: number;
  readonly message: string;
  readonly error: EncodedRequestError;
}

export type Failure = Data.TaggedEnum<{ Failure: FailureFields }>;

export type Outcome<A> = Data.TaggedEnum<{
  Failure: FailureFields;
  Success: { readonly value: A };
}>;

interface OutcomeDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Outcome<this["A"]>;
}

const outcomeConstructors = Data.taggedEnum<OutcomeDefinition>();

export const failureOutcome = (fields: FailureFields): Failure =>
  outcomeConstructors.Failure(fields);

export const success = <A>(value: A): Outcome<A> =>
  outcomeConstructors.Success({ value });

export type FieldErrors = Readonly<Record<string, readonly string[]>>;

/** Field → messages, for forms (empty unless the failure is `ValidationFailed`). */
export const fieldErrors = (
  result: Outcome<unknown> | null | undefined
): FieldErrors => {
  if (
    !result ||
    Predicate.isTagged(result, "Success") ||
    !Predicate.isTagged(result.error, "ValidationFailed")
  ) {
    return {};
  }

  const fields = new Map<string, string[]>();

  for (const issue of result.error.issues) {
    const key = Arr.join(issue.path, ".");
    const messages = fields.get(key);

    if (messages === undefined) {
      fields.set(key, [issue.message]);
    } else {
      messages.push(issue.message);
    }
  }

  return Rec.fromEntries(fields);
};

/** Tagged router error for a non-404 page failure. */
class PageFailureError extends Schema.TaggedError<
  PageFailureError,
  { readonly brand: unique symbol }
>()("PageFailureError", {
  message: Schema.String,
  status: Schema.Int,
}) {}

/**
 * The route-loader rule: a page's data, or TanStack's `notFound()` for a 404
 * (e.g. a draft article, RULE-267), or a `PageFailureError` for any other failure.
 */
export const pageData = <A>(result: Outcome<A>): A => {
  if (Predicate.isTagged(result, "Success")) {
    return result.value;
  }

  if (result.status === 404) {
    throw notFound();
  }

  throw new PageFailureError({
    message: result.message,
    status: result.status,
  });
};
