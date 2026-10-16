import { assert, describe, it } from "@effect/vitest";
import { SlackChannel } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Layer, Predicate, Record as Rec } from "effect";

import {
  contactCommand,
  prepareContact,
  readContactSubmission,
} from "../src/server/contact";
import { contactRateLimiterTestLayer } from "../src/server/rateLimit";
import { runCommandOutcome } from "../src/server/runtime";
import {
  CAPTCHA_FIELD,
  TURNSTILE_RESPONSE_FIELD,
  turnstileTestLayer,
} from "../src/server/turnstile";
import { fakeDepartment, makeTables, memoryLayer } from "./support/memory";

const { signal } = new AbortController();

const VALID_TOKEN = "fake-turnstile-token";

const form = (fields: Record<string, string>): FormData => {
  const data = new FormData();

  for (const [name, value] of Rec.toEntries(fields)) {
    data.set(name, value);
  }

  return data;
};

const ticket = {
  departmentId: "1",
  email: "kari@example.com",
  message: "Når åpner opptaket?",
  name: "Kari Eksempel",
  subject: "Spørsmål om opptak",
};

/** The `/kontakt` pipeline against in-memory Layers; returns the outcome and the tables after it. */
const post = (fields: Record<string, string>, allowed = 5) => {
  const tables = makeTables({
    departments: [
      fakeDepartment(1, "Trondheim", {
        slackChannel: SlackChannel.make("#trondheim"),
      }),
    ],
  });

  const layer = Layer.mergeAll(
    memoryLayer(tables),
    turnstileTestLayer(VALID_TOKEN),
    contactRateLimiterTestLayer(allowed)
  );

  const submission = readContactSubmission(
    form(fields),
    new Headers({ "CF-Connecting-IP": "192.0.2.10" })
  );

  return Effect.gen(function* submitContact() {
    const outcome = yield* Effect.promise(
      async () =>
        await runCommandOutcome(
          layer,
          prepareContact(submission),
          () => contactCommand(submission),
          signal
        )
    );

    return { outcome, tables };
  });
};

describe("C10 /kontakt", () => {
  it.effect(
    "RULE-167: a submission without a Turnstile token is rejected and no outbox row is written",
    () =>
      Effect.gen(function* contactWithoutToken() {
        const { outcome, tables } = yield* post(ticket);
        assert.isTrue(Predicate.isTagged(outcome, "Failure"));

        if (Predicate.isTagged(outcome, "Failure")) {
          assert.strictEqual(outcome.status, 400);
          assert.strictEqual(outcome.formStatus, 422);
          assert.isTrue(Predicate.isTagged(outcome.error, "ValidationFailed"));

          if (Predicate.isTagged(outcome.error, "ValidationFailed")) {
            assert.deepStrictEqual(outcome.error.issues[0]?.path, [
              CAPTCHA_FIELD,
            ]);
          }
        }

        assert.deepStrictEqual(tables.outbox, []);
        assert.strictEqual(tables.commits, 0);
      })
  );

  it.effect(
    "RULE-167: an invalid token is rejected the same way, before submitContact runs",
    () =>
      Effect.gen(function* contactWithInvalidToken() {
        const { outcome, tables } = yield* post({
          ...ticket,
          [TURNSTILE_RESPONSE_FIELD]: "forged",
        });

        assert.isTrue(Predicate.isTagged(outcome, "Failure"));

        assert.deepStrictEqual(tables.outbox, []);
        assert.strictEqual(tables.commits, 0);
      })
  );

  it.effect(
    "RULE-167 + RULE-249: a verified submission commits the notifications to the outbox",
    () =>
      Effect.gen(function* contactWithVerifiedToken() {
        const { outcome, tables } = yield* post({
          ...ticket,
          [TURNSTILE_RESPONSE_FIELD]: VALID_TOKEN,
        });

        assert.isTrue(Predicate.isTagged(outcome, "Success"));

        if (Predicate.isTagged(outcome, "Success")) {
          assert.strictEqual(outcome.value.enqueued.length, 4);
          assert.strictEqual(outcome.value.value.departmentId, 1);
        }

        assert.deepStrictEqual(
          Arr.map(tables.outbox, (row) => row.message._tag),
          ["Email", "Email", "SlackPost", "SlackPost"]
        );
        assert.strictEqual(tables.commits, 1);
      })
  );

  it.effect(
    "RULE-156: an invalid e-mail re-renders the form (422) and sends nothing",
    () =>
      Effect.gen(function* contactWithInvalidEmail() {
        const { outcome, tables } = yield* post({
          ...ticket,
          email: "ola@",
          [TURNSTILE_RESPONSE_FIELD]: VALID_TOKEN,
        });

        assert.isTrue(Predicate.isTagged(outcome, "Failure"));

        if (Predicate.isTagged(outcome, "Failure")) {
          assert.strictEqual(outcome.formStatus, 422);
        }

        assert.deepStrictEqual(tables.outbox, []);
      })
  );

  it.effect(
    "the per-IP rate limit answers 429 before Turnstile or the database is touched",
    () =>
      Effect.gen(function* contactRateLimited() {
        const { outcome, tables } = yield* post(
          { ...ticket, [TURNSTILE_RESPONSE_FIELD]: VALID_TOKEN },
          0
        );

        assert.isTrue(Predicate.isTagged(outcome, "Failure"));

        if (Predicate.isTagged(outcome, "Failure")) {
          assert.strictEqual(outcome.status, 429);
        }

        assert.strictEqual(tables.commits, 0);
        assert.deepStrictEqual(tables.outbox, []);
      })
  );

  it("reads the form and the client IP before entering Effect", () => {
    const submission = readContactSubmission(
      form({ ...ticket, [TURNSTILE_RESPONSE_FIELD]: "t" }),
      new Headers({ "CF-Connecting-IP": "192.0.2.10" })
    );

    assert.deepStrictEqual(submission, {
      captchaToken: "t",
      remoteIp: "192.0.2.10",
      values: ticket,
    });
  });
});
