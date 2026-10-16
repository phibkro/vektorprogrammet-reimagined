/**
 * Assertions over the runtime's serializable `Outcome`, shared by the web
 * tests that drive a server path end to end. The helper narrows the tagged
 * value and returns it, so a test asserts its own detail on a typed result.
 */
import { assert } from "@effect/vitest";
import { Predicate } from "effect";

import type { Outcome } from "../../src/lib/outcome";
import { ERROR_TABLE } from "../../src/server/errors";
import type { EncodedRequestError } from "../../src/server/errors";

/** The `ValidationFailed` failure as the browser receives it. */
type EncodedValidationFailure = Extract<
  EncodedRequestError,
  { readonly _tag: "ValidationFailed" }
>;

/**
 * Asserts the outcome is a `ValidationFailed` failure with the error table's
 * own statuses for that tagged error, and returns the encoded error.
 */
export const assertValidationFailure = (
  outcome: Outcome<unknown>
): EncodedValidationFailure => {
  assert.isTrue(Predicate.isTagged(outcome, "Failure"), "expected a failure");

  if (!Predicate.isTagged(outcome, "Failure")) {
    assert.fail("expected a failure");
  }

  assert.strictEqual(outcome.status, ERROR_TABLE.ValidationFailed.status);
  assert.strictEqual(
    outcome.formStatus,
    ERROR_TABLE.ValidationFailed.formStatus
  );
  assert.isTrue(
    Predicate.isTagged(outcome.error, "ValidationFailed"),
    "expected a validation failure"
  );

  if (!Predicate.isTagged(outcome.error, "ValidationFailed")) {
    assert.fail("expected a validation failure");
  }

  return outcome.error;
};
