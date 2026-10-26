/**
 * Assertions over the runtime's serializable `Outcome`, shared by the web
 * tests that drive a server path end to end. The helper narrows the tagged
 * value and returns it, so a test asserts its own detail on a typed result.
 */
import { assert } from "@effect/vitest";
import { Predicate } from "effect";

import type { Outcome } from "../../src/lib/outcome";
import { ERROR_TABLE } from "../../src/server/errors";
import type {
  EncodedRequestError,
  RequestErrorTag,
} from "../../src/server/errors";

type FailedOutcome = Extract<Outcome<unknown>, { readonly _tag: "Failure" }>;

/** The value of a successful outcome; a failure fails the test and names the error. */
export const assertSuccess = <A>(outcome: Outcome<A>): A => {
  if (Predicate.isTagged(outcome, "Failure")) {
    assert.fail(
      `expected success, received ${outcome.error._tag}: ${outcome.message}`
    );
  }

  return outcome.value;
};

/**
 * Asserts the outcome is a failure of the tagged error `tag` with the error table's own statuses for
 * it (the server function sends `status` as the HTTP status of its reply), and returns the failure.
 */
export const assertRefused = (
  outcome: Outcome<unknown>,
  tag: RequestErrorTag
): FailedOutcome => {
  if (!Predicate.isTagged(outcome, "Failure")) {
    return assert.fail(`expected ${tag}, received a success`);
  }

  assert.strictEqual(outcome.error._tag, tag, outcome.message);
  assert.strictEqual(outcome.status, ERROR_TABLE[tag].status);
  assert.strictEqual(outcome.formStatus, ERROR_TABLE[tag].formStatus);

  return outcome;
};

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

/** Whether the command refused the principal (403): what a hidden control must agree with. */
export const isForbidden = (outcome: Outcome<unknown>): boolean =>
  Predicate.isTagged(outcome, "Failure") &&
  Predicate.isTagged(outcome.error, "Forbidden");

/** Whether the command went through. */
export const isSuccess = (outcome: Outcome<unknown>): boolean =>
  Predicate.isTagged(outcome, "Success");
