import { assert, describe, it } from "@effect/vitest";
import { SlackChannel } from "@vektorprogrammet/domain";
import { Layer } from "effect";
import { contactCommand, prepareContact, readContactSubmission } from "../src/server/contact";
import { contactRateLimiterTestLayer } from "../src/server/rateLimit";
import { runCommandOutcome } from "../src/server/runtime";
import {
  CAPTCHA_FIELD,
  TURNSTILE_RESPONSE_FIELD,
  turnstileTestLayer,
} from "../src/server/turnstile";
import { fakeDepartment, makeTables, memoryLayer } from "./support/memory";

const signal = new AbortController().signal;
const VALID_TOKEN = "fake-turnstile-token";

const form = (fields: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

const ticket = {
  name: "Kari Eksempel",
  email: "kari@example.com",
  subject: "Spørsmål om opptak",
  message: "Når åpner opptaket?",
  departmentId: "1",
};

/** The `/kontakt` pipeline against in-memory Layers; returns the outcome and the tables after it. */
const post = (fields: Record<string, string>, allowed = 5) => {
  const tables = makeTables({
    departments: [
      fakeDepartment(1, "Trondheim", { slackChannel: SlackChannel.make("#trondheim") }),
    ],
  });
  const layer = Layer.mergeAll(
    memoryLayer(tables),
    turnstileTestLayer(VALID_TOKEN),
    contactRateLimiterTestLayer(allowed),
  );
  const submission = readContactSubmission(
    form(fields),
    new Headers({ "CF-Connecting-IP": "192.0.2.10" }),
  );
  return runCommandOutcome(
    layer,
    prepareContact(submission),
    () => contactCommand(submission),
    signal,
  ).then((outcome) => ({ outcome, tables }));
};

describe("C10 /kontakt", () => {
  it("RULE-167: a submission without a Turnstile token is rejected and no outbox row is written", () =>
    post(ticket).then(({ outcome, tables }) => {
      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.status, 400);
        assert.strictEqual(outcome.formStatus, 422);
        assert.strictEqual(outcome.error._tag, "ValidationFailed");
        if (outcome.error._tag === "ValidationFailed") {
          assert.deepStrictEqual(outcome.error.issues[0]?.path, [CAPTCHA_FIELD]);
        }
      }
      assert.deepStrictEqual(tables.outbox, []);
      assert.strictEqual(tables.commits, 0);
    }));

  it("RULE-167: an invalid token is rejected the same way, before submitContact runs", () =>
    post({ ...ticket, [TURNSTILE_RESPONSE_FIELD]: "forged" }).then(({ outcome, tables }) => {
      assert.strictEqual(outcome._tag, "Failure");
      assert.deepStrictEqual(tables.outbox, []);
      assert.strictEqual(tables.commits, 0);
    }));

  it("RULE-167 + RULE-249: a verified submission commits the notifications to the outbox", () =>
    post({ ...ticket, [TURNSTILE_RESPONSE_FIELD]: VALID_TOKEN }).then(({ outcome, tables }) => {
      assert.strictEqual(outcome._tag, "Success");
      if (outcome._tag === "Success") {
        assert.strictEqual(outcome.value.enqueued.length, 4);
        assert.strictEqual(outcome.value.value.departmentId, 1);
      }
      assert.deepStrictEqual(
        tables.outbox.map((row) => row.message._tag),
        ["Email", "Email", "SlackPost", "SlackPost"],
      );
      assert.strictEqual(tables.commits, 1);
    }));

  it("RULE-156: an invalid e-mail re-renders the form (422) and sends nothing", () =>
    post({ ...ticket, email: "ola@", [TURNSTILE_RESPONSE_FIELD]: VALID_TOKEN }).then(
      ({ outcome, tables }) => {
        assert.strictEqual(outcome._tag, "Failure");
        if (outcome._tag === "Failure") assert.strictEqual(outcome.formStatus, 422);
        assert.deepStrictEqual(tables.outbox, []);
      },
    ));

  it("the per-IP rate limit answers 429 before Turnstile or the database is touched", () =>
    post({ ...ticket, [TURNSTILE_RESPONSE_FIELD]: VALID_TOKEN }, 0).then(({ outcome, tables }) => {
      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") assert.strictEqual(outcome.status, 429);
      assert.strictEqual(tables.commits, 0);
      assert.deepStrictEqual(tables.outbox, []);
    }));

  it("reads the form and the client IP before entering Effect", () => {
    const submission = readContactSubmission(
      form({ ...ticket, [TURNSTILE_RESPONSE_FIELD]: "t" }),
      new Headers({ "CF-Connecting-IP": "192.0.2.10" }),
    );
    assert.deepStrictEqual(submission, {
      values: ticket,
      captchaToken: "t",
      remoteIp: "192.0.2.10",
    });
  });
});
