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

/** The key a `ValidationFailed` issue files under: the dotted path, which a `Field` of that name shows. */
const issueKey = (issue: { readonly path: readonly string[] }): string =>
  Arr.join(issue.path, ".");

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
    const key = issueKey(issue);
    const messages = fields.get(key);

    if (messages === undefined) {
      fields.set(key, [issue.message]);
    } else {
      messages.push(issue.message);
    }
  }

  return Rec.fromEntries(fields);
};

/**
 * The text of a failure that no visible field shows: every failure but a validation one (a refusal,
 * a duplicate, a missing row), and each validation issue whose path is not one of `shownFields`,
 * the names of the fields the form renders. An issue on a hidden input, or on no field at all,
 * has nowhere else to appear and must not be lost (issue 26).
 */
export const formLevelMessage = (
  result: Outcome<unknown> | null | undefined,
  shownFields: ReadonlySet<string>
): string | null => {
  if (!result || Predicate.isTagged(result, "Success")) {
    return null;
  }

  if (!Predicate.isTagged(result.error, "ValidationFailed")) {
    return result.message;
  }

  const unshown = Arr.filter(
    result.error.issues,
    (issue) => !shownFields.has(issueKey(issue))
  );

  return unshown.length === 0
    ? null
    : Arr.join(
        Arr.map(unshown, (issue) => issue.message),
        " "
      );
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
