import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  DEPARTMENT_UNAVAILABLE_MESSAGE,
  DepartmentId,
  EmailAddress,
  INVALID_EMAIL_MESSAGE,
  SlackChannel,
  submitContact,
  type Department,
  type DomainError,
} from "../../src/index.ts";
import { BERGEN, TRONDHEIM, TestServices, seed, table } from "../support/inMemory.ts";

// Fake same-shape values; no legacy personal data.
const department = (id: DepartmentId, city: string, slackChannel: string | null): Department => ({
  id,
  name: `Vektor ${city}`,
  shortName: city.toUpperCase(),
  email: EmailAddress.make(`${city.toLowerCase()}@example.org`),
  city,
  address: null,
  active: true,
  slackChannel: slackChannel === null ? null : SlackChannel.make(slackChannel),
  logoKey: null,
  latitude: null,
  longitude: null,
});

const ticket = {
  name: "Kari Eksempel",
  email: "kari@example.com",
  subject: "Spørsmål om opptak",
  message: "Når åpner opptaket?",
  departmentId: TRONDHEIM,
};

const fieldsOf = (error: DomainError) =>
  error._tag === "ValidationFailed" ? error.issues.map((issue) => issue.path.join(".")) : [];

describe("C10 contact form", () => {
  it.effect("RULE-156: an invalid e-mail ('ola@') is rejected and nothing is sent", () =>
    Effect.gen(function* () {
      yield* seed.department(department(TRONDHEIM, "Trondheim", "#trondheim"));
      const error = yield* Effect.flip(submitContact({ ...ticket, email: "ola@" }));
      assert.strictEqual(error._tag, "ValidationFailed");
      if (error._tag === "ValidationFailed") {
        assert.deepStrictEqual(error.issues, [{ path: ["email"], message: INVALID_EMAIL_MESSAGE }]);
      }
      assert.deepStrictEqual(yield* table((db) => db.outbox), []);
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-156: name, subject, message and region are required", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        submitContact({ email: "kari@example.com", name: " ", subject: "" }),
      );
      assert.deepStrictEqual(fieldsOf(error).sort(), [
        "departmentId",
        "message",
        "name",
        "subject",
      ]);
      assert.deepStrictEqual(yield* table((db) => db.outbox), []);
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect(
    "RULE-327: the visitor picks the department; an unknown or inactive one sends nothing",
    () =>
      Effect.gen(function* () {
        yield* seed.department({ ...department(BERGEN, "Bergen", null), active: false });
        for (const departmentId of [BERGEN, DepartmentId.make(77)]) {
          const error = yield* Effect.flip(submitContact({ ...ticket, departmentId }));
          assert.strictEqual(error._tag, "ValidationFailed");
          if (error._tag === "ValidationFailed") {
            assert.deepStrictEqual(error.issues, [
              { path: ["departmentId"], message: DEPARTMENT_UNAVAILABLE_MESSAGE },
            ]);
          }
        }
        assert.deepStrictEqual(yield* table((db) => db.outbox), []);
      }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-327: the ticket goes to the department the visitor chose (no geolocation)", () =>
    Effect.gen(function* () {
      yield* seed.department(department(TRONDHEIM, "Trondheim", null));
      yield* seed.department(department(BERGEN, "Bergen", null));
      const result = yield* submitContact({ ...ticket, departmentId: BERGEN });
      assert.strictEqual(result.departmentId, BERGEN);
      const [first] = yield* table((db) => db.outbox);
      assert.isTrue(first?._tag === "Email" && first.to === "bergen@example.org");
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect("RULE-249: a department with a Slack channel gets exactly four messages in order", () =>
    Effect.gen(function* () {
      yield* seed.department(department(TRONDHEIM, "Trondheim", "#trondheim"));
      const result = yield* submitContact(ticket);
      assert.strictEqual(
        result.notice,
        "Kontaktforespørsel sendt til trondheim@example.org, takk for henvendelsen!",
      );
      const outbox = yield* table((db) => db.outbox);
      assert.strictEqual(result.messageIds.length, 4);
      assert.deepStrictEqual(
        outbox.map((m) =>
          m._tag === "Email"
            ? ["Email", m.to, m.replyTo]
            : [
                "SlackPost",
                m.target._tag === "Notifications" ? "#notifications" : m.target.channel,
              ],
        ),
        [
          ["Email", "trondheim@example.org", "kari@example.com"],
          ["Email", "kari@example.com", "trondheim@example.org"],
          ["SlackPost", "#trondheim"],
          ["SlackPost", "#notifications"],
        ],
      );
      const [departmentEmail, , departmentSlack] = outbox;
      assert.isTrue(
        departmentEmail?._tag === "Email" && departmentEmail.text.includes("Når åpner opptaket?"),
      );
      assert.isTrue(
        departmentSlack?._tag === "SlackPost" &&
          departmentSlack.text.includes("Når åpner opptaket?"),
      );
    }).pipe(Effect.provide(TestServices)),
  );

  it.effect(
    "RULE-249: without a department channel, three messages and #notifications still posts",
    () =>
      Effect.gen(function* () {
        yield* seed.department(department(TRONDHEIM, "Trondheim", null));
        yield* submitContact(ticket);
        const outbox = yield* table((db) => db.outbox);
        assert.deepStrictEqual(
          outbox.map((m) => m._tag),
          ["Email", "Email", "SlackPost"],
        );
        const last = outbox.at(-1);
        assert.isTrue(last?._tag === "SlackPost" && last.target._tag === "Notifications");
      }).pipe(Effect.provide(TestServices)),
  );
});
