import { assert, describe, it } from "@effect/vitest";
import { AlreadyExists, Forbidden, NotFound, validationFailed } from "@vektorprogrammet/domain";
import { Effect, Layer } from "effect";
import { ERROR_TABLE, RateLimited, failureOf } from "../src/server/errors";
import { runOutcome } from "../src/server/runtime";

const signal = new AbortController().signal;

describe("the one error table", () => {
  it("maps the domain's closed error set: NotFound 404, Forbidden 403, AlreadyExists 409, ValidationFailed 400", () => {
    assert.deepStrictEqual(
      [
        failureOf(new NotFound({ entity: "Article", key: "x" })).status,
        failureOf(new Forbidden({ capability: "ManageSemesters" })).status,
        failureOf(new AlreadyExists({ entity: "Semester", key: "HOST 2026", message: "finnes" }))
          .status,
        failureOf(validationFailed(["name"], "Feletet kan ikke være tomt.")).status,
      ],
      [404, 403, 409, 400],
    );
  });

  it("re-renders a no-JavaScript form with 422 on validation and 429 on the rate limit", () => {
    assert.strictEqual(ERROR_TABLE.ValidationFailed.formStatus, 422);
    assert.strictEqual(failureOf(new RateLimited()).status, 429);
  });

  it("produces plain, serializable failures with the domain's own text", () => {
    const failure = failureOf(
      new AlreadyExists({
        entity: "Semester",
        key: "HOST 2026",
        message: "Semesteret Høst 2026 finnes allerede",
      }),
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(failure)), failure);
    assert.strictEqual(failure.message, "Semesteret Høst 2026 finnes allerede");
    assert.deepStrictEqual(failure.error, {
      _tag: "AlreadyExists",
      entity: "Semester",
      key: "HOST 2026",
      message: "Semesteret Høst 2026 finnes allerede",
    });
  });

  it("keeps every validation issue for the form", () => {
    const failure = failureOf(validationFailed(["email"], "Ugyldig e-postadresse."));
    assert.deepStrictEqual(failure.error, {
      _tag: "ValidationFailed",
      issues: [{ path: ["email"], message: "Ugyldig e-postadresse." }],
    });
  });
});

describe("runOutcome", () => {
  it("maps a typed failure through the table", () =>
    runOutcome(
      Layer.empty,
      Effect.fail(new Forbidden({ capability: "EditStaticContent" })),
      signal,
    ).then((outcome) => {
      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") assert.strictEqual(outcome.status, 403);
    }));

  it("succeeds with the value", () =>
    runOutcome(Layer.empty, Effect.succeed(42), signal).then((outcome) =>
      assert.deepStrictEqual(outcome, { _tag: "Success", value: 42 }),
    ));

  it("rejects on a defect (the framework answers 500) instead of inventing a status", () =>
    runOutcome(Layer.empty, Effect.die(new Error("connection lost")), signal).then(
      () => assert.fail("a defect must not resolve"),
      (error: unknown) => assert.isDefined(error),
    ));

  it("is interrupted by the request's AbortSignal", () => {
    const controller = new AbortController();
    const running = runOutcome(Layer.empty, Effect.never, controller.signal);
    controller.abort();
    return running.then(
      () => assert.fail("an aborted request must not resolve"),
      (error: unknown) => assert.isDefined(error),
    );
  });
});
