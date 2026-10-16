import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  Effect,
  Match,
  Order,
  Predicate,
  Schema,
  pipe,
} from "effect";

import {
  DEPARTMENT_UNAVAILABLE_MESSAGE,
  DepartmentId,
  INVALID_EMAIL_MESSAGE,
  SupportTicket,
  submitContact,
  supportTicketMessages,
} from "../../src/index.ts";
import type { DomainError } from "../../src/index.ts";
import {
  BERGEN,
  TRONDHEIM,
  TestServices,
  assertNoRows,
  departmentForTest,
  seed,
  table,
} from "../support/inMemory.ts";

const department = (
  id: DepartmentId,
  city: string,
  slackChannel: string | null
) => departmentForTest(id, city, city.toUpperCase(), slackChannel);

const ticket = {
  departmentId: TRONDHEIM,
  email: "kari@example.com",
  message: "Når åpner opptaket?",
  name: "Kari Eksempel",
  subject: "Spørsmål om opptak",
};

const fieldsOf = (error: DomainError) =>
  Predicate.isTagged(error, "ValidationFailed")
    ? pipe(
        error.issues,
        Arr.map((issue) => Arr.join(issue.path, "."))
      )
    : [];

describe("C10 contact form", () => {
  it.effect(
    "RULE-156: an invalid e-mail ('ola@') is rejected and nothing is sent",
    () =>
      Effect.gen(function* effectProgram() {
        yield* seed.department(
          department(TRONDHEIM, "Trondheim", "#trondheim")
        );

        const error = yield* Effect.flip(
          submitContact({ ...ticket, email: "ola@" })
        );

        assert.strictEqual(error._tag, "ValidationFailed");

        if (Predicate.isTagged(error, "ValidationFailed")) {
          assert.deepStrictEqual(error.issues, [
            { message: INVALID_EMAIL_MESSAGE, path: ["email"] },
          ]);
        }

        assertNoRows([yield* table((db) => db.outbox)]);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect("RULE-156: name, subject, message and region are required", () =>
    Effect.gen(function* effectProgram() {
      const error = yield* Effect.flip(
        submitContact({ email: "kari@example.com", name: " ", subject: "" })
      );

      assert.deepStrictEqual(Arr.sort(fieldsOf(error), Order.String), [
        "departmentId",
        "message",
        "name",
        "subject",
      ]);
      assertNoRows([yield* table((db) => db.outbox)]);
    }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-327: the visitor picks the department; an unknown or inactive one sends nothing",
    () =>
      Effect.gen(function* effectProgram() {
        yield* seed.department({
          ...department(BERGEN, "Bergen", null),
          active: false,
        });

        for (const departmentId of [BERGEN, DepartmentId.make(77)]) {
          const error = yield* Effect.flip(
            submitContact({ ...ticket, departmentId })
          );

          assert.strictEqual(error._tag, "ValidationFailed");

          if (Predicate.isTagged(error, "ValidationFailed")) {
            assert.deepStrictEqual(error.issues, [
              {
                message: DEPARTMENT_UNAVAILABLE_MESSAGE,
                path: ["departmentId"],
              },
            ]);
          }
        }

        assertNoRows([yield* table((db) => db.outbox)]);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-327: the ticket goes to the department the visitor chose (no geolocation)",
    () =>
      Effect.gen(function* effectProgram() {
        yield* seed.department(department(TRONDHEIM, "Trondheim", null));
        yield* seed.department(department(BERGEN, "Bergen", null));

        const result = yield* submitContact({
          ...ticket,
          departmentId: BERGEN,
        });

        assert.strictEqual(result.departmentId, BERGEN);
        const [first] = yield* table((db) => db.outbox);
        assert.isTrue(
          first?._tag === "Email" && first.to === "bergen@example.org"
        );
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-249: a department with a Slack channel gets exactly four messages in order",
    () =>
      Effect.gen(function* effectProgram() {
        yield* seed.department(
          department(TRONDHEIM, "Trondheim", "#trondheim")
        );
        const result = yield* submitContact(ticket);
        assert.strictEqual(
          result.notice,
          "Kontaktforespørsel sendt til trondheim@example.org, takk for henvendelsen!"
        );
        const outbox = yield* table((db) => db.outbox);
        assert.strictEqual(result.messageIds.length, 4);
        assert.deepStrictEqual(
          pipe(
            outbox,
            Arr.map((m): readonly (string | null)[] =>
              Predicate.isTagged(m, "Email")
                ? ["Email", m.to, m.replyTo]
                : [
                    "SlackPost",
                    Match.value(m.target).pipe(
                      Match.tag("Notifications", () => "#notifications"),
                      Match.tag(
                        "DepartmentChannel",
                        (target) => target.channel
                      ),
                      Match.exhaustive
                    ),
                  ]
            )
          ),
          [
            ["Email", "trondheim@example.org", "kari@example.com"],
            ["Email", "kari@example.com", "trondheim@example.org"],
            ["SlackPost", "#trondheim"],
            ["SlackPost", "#notifications"],
          ]
        );
        const [departmentEmail, , departmentSlack] = outbox;
        assert.isTrue(
          departmentEmail?._tag === "Email" &&
            departmentEmail.text.includes("Når åpner opptaket?")
        );
        assert.isTrue(
          departmentSlack?._tag === "SlackPost" &&
            departmentSlack.text.includes("Når åpner opptaket?")
        );
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-249: without a department channel, three messages and #notifications still posts",
    () =>
      Effect.gen(function* effectProgram() {
        yield* seed.department(department(TRONDHEIM, "Trondheim", null));
        yield* submitContact(ticket);
        const outbox = yield* table((db) => db.outbox);
        assert.deepStrictEqual(
          pipe(
            outbox,
            Arr.map((m) => m._tag)
          ),
          ["Email", "Email", "SlackPost"]
        );
        const last = outbox.at(-1);
        assert.isTrue(
          Predicate.isTagged(last, "SlackPost") &&
            Predicate.isTagged(last.target, "Notifications")
        );
      }).pipe(Effect.provide(TestServices))
  );
});

// Fixtures F43/F44 of the independent verification; the expected strings are
// the legacy output (SupportTicketSubscriber + SlackMessenger), except the
// trailing space legacy left after "vektorprogrammet.no.", which is not
// product meaning.
const slackTexts = Effect.fn("slackTexts")(function* slackTexts(
  slackChannel: string | null,
  message: string
) {
  const decoded = yield* Schema.decodeEffect(SupportTicket)({
    ...ticket,
    email: "ola@skole.example",
    message,
    name: "Ola Nordmann",
    subject: "Assistent til 9A",
  });

  return pipe(
    supportTicketMessages(
      decoded,
      departmentForTest(TRONDHEIM, "Kristiansand", "UiA", slackChannel)
    ),
    Arr.flatMap((outbox) =>
      Predicate.isTagged(outbox, "SlackPost") ? [outbox.text] : []
    )
  );
});

describe("RULE-249 legacy-equal Slack text", () => {
  it.effect(
    "RULE-249 F43: #notifications starts with the department city, as legacy does",
    () =>
      Effect.gen(function* effectProgram() {
        assert.deepStrictEqual(yield* slackTexts(null, "Hei!"), [
          Arr.join(
            [
              "Kristiansand: Ny melding mottatt fra *Ola Nordmann*. Meldingen ble sendt fra et kontaktskjema på vektorprogrammet.no.",
              "Emne: `Assistent til 9A`",
              "Meldingen har blitt videresendt til kristiansand@example.org",
            ],
            "\n"
          ),
        ]);
      })
  );

  it.effect(
    "RULE-249 F44: the department channel message closes the code block with no newline before the fence, as legacy does",
    () =>
      Effect.gen(function* effectProgram() {
        const [departmentChannel] = yield* slackTexts(
          "#uia-styret",
          "Hei!\nKan dere sende en assistent?"
        );

        assert.strictEqual(
          departmentChannel,
          Arr.join(
            [
              "Ny henvendelse fra Ola Nordmann (ola@skole.example).",
              "Emne: `Assistent til 9A`",
              "```",
              "Hei!",
              "Kan dere sende en assistent?```",
            ],
            "\n"
          )
        );
      })
  );
});
