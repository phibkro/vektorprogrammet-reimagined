import { assert, describe, it } from "@effect/vitest";
import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
} from "@supabase/supabase-js";
import { SignInMatch } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Ref } from "effect";

import { recoveryResponse, sessionFailure } from "../src/server/auth";
import { AuthBoundaryFailure } from "../src/server/authError";

const failed = () =>
  Effect.fail(new AuthBoundaryFailure({ cause: "provider unavailable" }));

describe("password recovery privacy", () => {
  it.effect(
    "gives the same response for unknown, ambiguous, successful and failed delivery",
    () =>
      Effect.gen(function* checkRecoveryPrivacy() {
        const unknown = SignInMatch.cases.Unknown.make({});
        const ambiguous = SignInMatch.cases.Ambiguous.make({});

        const matched = SignInMatch.cases.Unique.make({
          email: "person@example.org",
        });

        const calls = yield* Ref.make(0);
        const send = () => Ref.update(calls, (count) => count + 1);

        const responses = yield* Effect.all([
          recoveryResponse(unknown, send),
          recoveryResponse(ambiguous, send),
          recoveryResponse(matched, send),
          recoveryResponse(matched, failed),
        ]);

        assert.strictEqual(yield* Ref.get(calls), 1);

        const bodies = yield* Effect.forEach(responses, (response) =>
          Effect.tryPromise({
            catch: (cause) => new AuthBoundaryFailure({ cause }),
            try: () => response.text(),
          })
        );

        assert.deepStrictEqual(
          Arr.map(responses, (response) => response.status),
          [200, 200, 200, 200]
        );
        assert.deepStrictEqual(bodies, [
          bodies[0],
          bodies[0],
          bodies[0],
          bodies[0],
        ]);
      }).pipe(Effect.orDie)
  );
});

describe("Supabase session failure classification", () => {
  it.effect(
    "expired refresh credentials become anonymous while provider failures remain visible",
    () =>
      Effect.gen(function* classifySessionErrors() {
        const invalid = [
          new AuthSessionMissingError(),
          new AuthApiError("stale refresh", 400, "refresh_token_not_found"),
          new AuthApiError("reused refresh", 400, "refresh_token_already_used"),
          new AuthApiError("expired", 401, "session_expired"),
        ];

        const unrelated = [
          new AuthApiError("bad request", 400, "validation_failed"),
          new AuthApiError("configuration refused", 401, "no_authorization"),
          new AuthApiError("provider failure", 500, "refresh_token_not_found"),
          new AuthRetryableFetchError("network unavailable", 503),
        ];

        for (const error of invalid) {
          assert.isNull(yield* sessionFailure(error));
        }

        for (const error of unrelated) {
          const failure = yield* Effect.flip(sessionFailure(error));
          assert.instanceOf(failure, AuthBoundaryFailure);
          assert.strictEqual(failure.cause, error);
        }
      })
  );
});
