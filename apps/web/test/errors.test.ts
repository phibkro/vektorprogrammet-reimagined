import { assert, describe, it } from "@effect/vitest";
import {
  AlreadyExists,
  Forbidden,
  NotFound,
  ValidationFailed,
  validationFailed,
} from "@vektorprogrammet/domain";
import { Cause, Effect, Exit, Layer, Predicate, Schema } from "effect";

import { success } from "../src/lib/outcome";
import { ERROR_TABLE, RateLimited, failureOf } from "../src/server/errors";
import { runOutcome } from "../src/server/runtime";

const { signal } = new AbortController();

describe("the one error table", () => {
  it("maps the domain's closed error set: NotFound 404, Forbidden 403, AlreadyExists 409, ValidationFailed 400", () => {
    assert.deepStrictEqual(
      [
        failureOf(new NotFound({ entity: "Article", key: "x" })).status,
        failureOf(new Forbidden({ capability: "ManageSemesters" })).status,
        failureOf(
          new AlreadyExists({
            entity: "Semester",
            key: "HOST 2026",
            message: "finnes",
          })
        ).status,
        failureOf(validationFailed(["name"], "Feletet kan ikke være tomt."))
          .status,
      ],
      [404, 403, 409, 400]
    );
  });

  it("re-renders a no-JavaScript form with 422 on validation and 429 on the rate limit", () => {
    assert.strictEqual(ERROR_TABLE.ValidationFailed.formStatus, 422);
    assert.strictEqual(failureOf(new RateLimited()).status, 429);
  });

  it.effect(
    "produces plain, serializable failures with the domain's own text",
    () =>
      Effect.gen(function* producesPlainFailures() {
        const error = new AlreadyExists({
          entity: "Semester",
          key: "HOST 2026",
          message: "Semesteret Høst 2026 finnes allerede",
        });

        const failure = failureOf(error);
        const encoded = yield* Schema.encodeEffect(AlreadyExists)(error);

        const json = Schema.fromJsonString(Schema.Unknown);
        const wire = yield* Schema.encodeEffect(json)(failure);

        assert.deepStrictEqual(yield* Schema.decodeEffect(json)(wire), failure);
        assert.strictEqual(
          failure.message,
          "Semesteret Høst 2026 finnes allerede"
        );
        assert.deepStrictEqual(failure.error, encoded);
      })
  );

  it.effect("keeps every validation issue for the form", () =>
    Effect.gen(function* keepsEveryIssue() {
      const error = validationFailed(["email"], "Ugyldig e-postadresse.");
      const failure = failureOf(error);
      const encoded = yield* Schema.encodeEffect(ValidationFailed)(error);

      assert.deepStrictEqual(failure.error, encoded);
    })
  );
});

/** Boundary adapter: a platform AbortController cancels the request mid-flight. */
const startThenAbort = async () => {
  const controller = new AbortController();
  const running = runOutcome(Layer.empty, Effect.never, controller.signal);

  controller.abort();

  return await running;
};

describe("runOutcome", () => {
  it.effect("maps a typed failure through the table", () =>
    Effect.gen(function* mapsTypedFailure() {
      const outcome = yield* Effect.promise(
        async () =>
          await runOutcome(
            Layer.empty,
            Effect.fail(new Forbidden({ capability: "EditStaticContent" })),
            signal
          )
      );

      assert.isTrue(Predicate.isTagged(outcome, "Failure"));

      if (Predicate.isTagged(outcome, "Failure")) {
        assert.strictEqual(outcome.status, 403);
      }
    })
  );

  it.effect("succeeds with the value", () =>
    Effect.gen(function* succeedsWithValue() {
      const outcome = yield* Effect.promise(
        async () => await runOutcome(Layer.empty, Effect.succeed(42), signal)
      );

      assert.deepStrictEqual(outcome, success(42));
    })
  );

  it.effect(
    "rejects on a defect (the framework answers 500) instead of inventing a status",
    () =>
      Effect.gen(function* defectResponse() {
        const exit = yield* Effect.exit(
          Effect.promise(
            async () =>
              await runOutcome(
                Layer.empty,
                Effect.die(new Error("connection lost")),
                signal
              )
          )
        );

        if (Exit.isFailure(exit)) {
          assert.isDefined(Cause.squash(exit.cause));
        } else {
          assert.fail("a defect must not resolve");
        }
      })
  );

  it.effect("is interrupted by the request's AbortSignal", () =>
    Effect.gen(function* interruptedRequest() {
      const exit = yield* Effect.exit(Effect.promise(startThenAbort));

      if (Exit.isFailure(exit)) {
        assert.isDefined(Cause.squash(exit.cause));
      } else {
        assert.fail("an aborted request must not resolve");
      }
    })
  );
});
