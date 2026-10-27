import { assert, describe, it } from "@effect/vitest";
import { MembershipId, PersonId } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Predicate,
  Record as Rec,
  Schema,
} from "effect";

import {
  Refused,
  RenewalIdSchema,
  RenewalInputSchema,
  Renewed,
  STOP_EVENT_TYPE,
  Stopped,
  WorkflowEventTypeSchema,
  decodeInput,
  decodeStop,
  decodeThrownError,
  encodeOutcome,
  extendCommandId,
  isWaitTimeout,
} from "../src/renewal.ts";

const parameters = {
  actorId: 7,
  dueAt: "2026-10-27T12:00:00.000Z",
  end: { term: "HOST", year: 2027 },
  membershipId: 11,
  personId: 5,
  renewalId: "renewal-1",
} as const;

const PERSONAL_KEYS = ["name", "email", "phone"] as const;

/** An encoded outcome has no personal key, and every value is a string or a number: ids, counts, literals, instants. */
const assertIdentifiersOnly = (
  encoded: Readonly<Record<string, number | string>>
) => {
  const keys = Rec.keys(encoded);

  for (const key of PERSONAL_KEYS) {
    assert.isFalse(Arr.contains(keys, key));
  }

  for (const value of Rec.values(encoded)) {
    assert.isTrue(Predicate.isString(value) || Predicate.isNumber(value));
  }
};

describe("the renewal wire contract", () => {
  it.effect(
    "parameters are identifiers and an instant, and encode back to the same JSON",
    () =>
      Effect.gen(function* roundTrip() {
        const input = yield* decodeInput(parameters);

        assert.strictEqual(input.actorId, PersonId.make(7));
        assert.strictEqual(input.membershipId, MembershipId.make(11));
        assert.strictEqual(
          DateTime.toEpochMillis(input.dueAt),
          1_793_102_400_000
        );
        assert.deepStrictEqual(
          yield* Schema.encodeEffect(RenewalInputSchema)(input),
          parameters
        );
      })
  );

  it.effect(
    "the end of the stop window is an optional instant that is never after the renewal date",
    () =>
      Effect.gen(function* stopWindow() {
        const early = yield* decodeInput({
          ...parameters,
          stopUntil: "2026-10-27T11:00:00.000Z",
        });

        const atTheDate = yield* decodeInput({
          ...parameters,
          stopUntil: parameters.dueAt,
        });

        const afterTheDate = yield* Effect.flip(
          decodeInput({ ...parameters, stopUntil: "2026-10-27T12:00:00.001Z" })
        );

        assert.strictEqual(
          DateTime.toEpochMillis(early.stopUntil ?? early.dueAt),
          1_793_098_800_000
        );
        assert.deepStrictEqual(
          yield* Schema.encodeEffect(RenewalInputSchema)(early),
          { ...parameters, stopUntil: "2026-10-27T11:00:00.000Z" }
        );
        assert.isDefined(atTheDate.stopUntil);
        assert.isTrue(Predicate.isTagged(afterTheDate, "SchemaError"));
      })
  );

  it.effect.each(PERSONAL_KEYS)(
    "refuses a %s in the parameters: personal data has no field",
    (key) =>
      Effect.gen(function* refusesPersonalKey() {
        const refused = yield* Effect.flip(
          decodeInput({ ...parameters, [key]: "Ada Admin" })
        );

        assert.isTrue(Predicate.isTagged(refused, "SchemaError"));
      })
  );

  it.effect.each([
    "",
    "Renewal-1",
    "renewal 1",
    "-renewal",
    `a${"b".repeat(63)}`,
  ])("refuses the renewal id %j: not a safe instance id", (renewalId) =>
    Effect.gen(function* refusesId() {
      const refused = yield* Effect.flip(
        decodeInput({ ...parameters, renewalId })
      );

      assert.isTrue(Predicate.isTagged(refused, "SchemaError"));
    })
  );

  it.effect("a fault is the one literal, never free text", () =>
    Effect.gen(function* faultLiteral() {
      const accepted = yield* decodeInput({
        ...parameters,
        fault: "failAfterCommitOnce",
      });

      const refused = yield* Effect.flip(
        decodeInput({ ...parameters, fault: "Ada Admin" })
      );

      assert.strictEqual(accepted.fault, "failAfterCommitOnce");
      assert.isTrue(Predicate.isTagged(refused, "SchemaError"));
    })
  );

  it.effect(
    "a stop event carries who stopped, when anyone did, and nothing else",
    () =>
      Effect.gen(function* stopPayload() {
        const stop = yield* decodeStop({ stoppedBy: 7 });

        // The Cloudflare CLI sends no payload: a stop through the Workflows API has none, and is anonymous.
        const anonymous = yield* decodeStop({});

        const refused = yield* Effect.flip(
          decodeStop({ email: "ada@example.org", stoppedBy: 7 })
        );

        assert.strictEqual(stop.stoppedBy, PersonId.make(7));
        assert.isUndefined(anonymous.stoppedBy);
        assert.isTrue(Predicate.isTagged(refused, "SchemaError"));
      })
  );

  it.effect(
    "every outcome encodes to identifiers, counts, literals and instants",
    () =>
      Effect.gen(function* outcomesAreIdentifiers() {
        const input = yield* decodeInput(parameters);
        const { membershipId, personId, renewalId } = input;

        const outcomes = [
          Renewed.make({
            attempt: 2,
            commandId: extendCommandId(renewalId),
            membershipId,
            personId,
            renewalId,
            version: 2,
          }),
          Stopped.make({
            membershipId,
            personId,
            renewalId,
            stoppedAt: input.dueAt,
            stoppedBy: input.actorId,
          }),
          Stopped.make({
            membershipId,
            personId,
            renewalId,
            stoppedAt: input.dueAt,
          }),
          Refused.make({
            membershipId,
            personId,
            reason: "Conflict",
            renewalId,
          }),
        ];

        for (const outcome of outcomes) {
          assertIdentifiersOnly(yield* encodeOutcome(outcome));
        }
      })
  );

  it("the command id of a renewal is stable and distinct per renewal", () => {
    const first = RenewalIdSchema.make("renewal-1");
    const second = RenewalIdSchema.make("renewal-2");

    assert.strictEqual(extendCommandId(first), extendCommandId(first));
    assert.notStrictEqual(extendCommandId(first), extendCommandId(second));
  });

  it("the stop event type is one the deployed engine accepts: letters, digits, hyphen and underscore, never a dot", () => {
    const accepted = Schema.is(WorkflowEventTypeSchema);

    assert.strictEqual(STOP_EVENT_TYPE, "renewal-stop");
    assert.isTrue(accepted(STOP_EVENT_TYPE));
    assert.isTrue(accepted("Stripe_webhook-2"));
    assert.isTrue(accepted("a".repeat(100)));

    // Cloudflare refuses these: a dot is `workflow.invalid_event_type`, and a type has 1 to 100 characters.
    assert.isFalse(accepted("renewal.stop"));
    assert.isFalse(accepted("renewal stop"));
    assert.isFalse(accepted(""));
    assert.isFalse(accepted("a".repeat(101)));
  });

  it("a wait timeout is recognized by the local engine's name and by the deployed message, and nothing else is one", () => {
    // The local engine: the error is named.
    const local = Object.assign(new Error("Execution timed out after 1000ms"), {
      name: "WorkflowTimeoutError",
    });

    // The deployed runtime: the first wake failed the instance with this message under the name `Error`.
    const deployed = new Error("Execution timed out after 18970ms");

    assert.isTrue(isWaitTimeout(decodeThrownError(local)));
    assert.isTrue(isWaitTimeout(decodeThrownError(deployed)));
    assert.isTrue(
      isWaitTimeout(
        decodeThrownError({
          message: "Execution timed out after 5ms",
          name: "Error",
        })
      )
    );
    assert.isTrue(
      isWaitTimeout(
        decodeThrownError({
          message: "something else",
          name: "WorkflowTimeoutError",
        })
      )
    );

    assert.isFalse(
      isWaitTimeout(decodeThrownError(new Error("connection refused")))
    );
    assert.isFalse(
      isWaitTimeout(
        decodeThrownError(new Error("Execution timed out after 5 minutes"))
      )
    );
    assert.isFalse(
      isWaitTimeout(
        decodeThrownError(new Error("the step Execution timed out after 5ms"))
      )
    );
    assert.isFalse(
      isWaitTimeout(decodeThrownError("Execution timed out after 5ms"))
    );
    assert.isFalse(isWaitTimeout(decodeThrownError(null)));
  });
});
