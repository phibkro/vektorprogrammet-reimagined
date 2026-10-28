/**
 * Spec 0007b falsifier 5, the delivery half: the `IssueCode` message of the alumni job is delivered as one e-mail with a
 * link to `/alumni?kode=…`, and a code (with the lifetime that its policy declares) that opens the answer and nothing else. A person who was erased while the
 * message waited gets no mail and no code. Without that erasure the same message sends, which is the negative control:
 * the skip is the erasure's doing, not a message that never sends.
 */
import { assert, layer } from "@effect/vitest";
import { transactional } from "@vektorprogrammet/db";
import {
  CodeToken,
  CurrentPrincipal,
  Outbox,
  OutboxMessage,
  PersonId,
  PersonalDataEndpoints,
  Principal,
  authorize,
  codePolicy,
  codePrincipal,
  lifetimeWords,
} from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { deliverPending, live, origin } from "./support/deliveryLive";

const ALUMNA = 601;
const ERASED = 602;

const self = (personId: number) =>
  Principal.cases.Person.make({
    memberships: [],
    personId: PersonId.make(personId),
  });

const mails = Schema.Array(
  Schema.Struct({ recipient: Schema.String, text: Schema.String })
);

const expiries = Schema.Array(
  Schema.Struct({ ms: Schema.Finite, subject: Schema.Int })
);

/** Two people who have left, with no account, and the message that asks each of them. */
const askBoth = Effect.gen(function* askBoth() {
  const sql = yield* SqlClient;
  yield* sql`insert into department (id, city, email, name, short_name) values (601, 'Alumniby', 'alumni@example.org', 'Alumni', 'ALU')`;
  yield* sql`insert into field_of_study (id, department_id, name, short_name) values (601, 601, 'Alumni', 'ALU')`;
  yield* sql`insert into person ${sql.insert([
    {
      email: "alma@example.org",
      field_of_study_id: 601,
      id: ALUMNA,
      name: "Alma Alumna",
    },
    {
      email: "erik@example.org",
      field_of_study_id: 601,
      id: ERASED,
      name: "Erik Erased",
    },
  ])}`;

  yield* transactional(
    Effect.gen(function* enqueue() {
      yield* (yield* Outbox).enqueue(
        Arr.makeBy(2, (index) =>
          OutboxMessage.cases.IssueCode.make({
            personId: PersonId.make(ALUMNA + index),
            purpose: "alumniConsent",
          })
        )
      );
    })
  );
}).pipe(Effect.orDie);

const answerByCode = (code: CodeToken, news: boolean) =>
  transactional(PersonalDataEndpoints.answerAlumniConsent({ code, news }));

layer(live, { excludeTestServices: true })(
  "spec 0007b falsifier 5: the alumni code mail",
  (it) => {
    it.effect(
      "an asked alumnus gets one mail with a link that only answers; an erased one gets nothing",
      () =>
        Effect.gen(function* alumniMail() {
          const sql = yield* SqlClient;
          yield* askBoth;

          // The message waits in the outbox while Erik erases himself: the person is anonymised and has no account.
          const erased = yield* transactional(
            PersonalDataEndpoints.erasePerson({ personId: ERASED }).pipe(
              Effect.provideService(CurrentPrincipal, self(ERASED))
            )
          );

          assert.isTrue(erased.erased);

          const receipts = yield* deliverPending;

          assert.deepStrictEqual(
            Arr.map(receipts, (receipt) => receipt._tag),
            ["Delivered", "Delivered"]
          );

          const sent = yield* Schema.decodeUnknownEffect(mails)(
            yield* sql`select recipient, text from captured_mail order by id`
          );

          // One mail, to Alma, naming the page and the lifetime that the policy declares.
          assert.deepStrictEqual(
            Arr.map(sent, (mail) => mail.recipient),
            ["alma@example.org"]
          );

          const [mail] = sent;
          assert.include(mail?.text ?? "", `${origin}/alumni?kode=c_`);
          assert.include(
            mail?.text ?? "",
            `Lenken virker i ${lifetimeWords(codePolicy.alumniConsent.lifetimeSeconds, "no")}`
          );

          // Only Alma has a code: Erik's message was acknowledged without minting one.
          const codes = yield* Schema.decodeUnknownEffect(expiries)(
            yield* sql`select subject, (extract(epoch from expires_at) * 1000)::float8 as ms from code where purpose = 'alumniConsent'`
          );

          assert.deepStrictEqual(
            Arr.map(codes, (row) => row.subject),
            [ALUMNA]
          );

          const found = /[?&]kode=(?<token>c_[A-Za-z0-9_-]{43})/u.exec(
            mail?.text ?? ""
          );

          assert.isNotNull(found);
          const token = CodeToken.make(found?.groups?.token ?? "");

          // The code answers, can be used again to correct the answer, and is the person's own record each time.
          const first = yield* answerByCode(token, true);
          const second = yield* answerByCode(token, false);

          assert.strictEqual(first.news, "yes");
          assert.strictEqual(second.news, "no");
          assert.isNull(second.keepDetails);

          // It opens the answer and nothing else, and only for its purpose.
          assert.isTrue(
            Option.isNone(yield* codePrincipal(token, "activation"))
          );
          const holder = yield* codePrincipal(token, "alumniConsent");
          assert.isTrue(Option.isSome(holder));

          if (Option.isSome(holder)) {
            const own = { personId: PersonId.make(ALUMNA) };
            assert.isTrue(authorize(holder.value, "answerAlumniConsent", own));
            assert.isFalse(authorize(holder.value, "exportMyData", own));
            assert.isFalse(authorize(holder.value, "erasePerson", own));
            assert.isFalse(authorize(holder.value, "setAlumniConsent", own));
          }

          // The lifetime that the policy declares, from the moment the code was made, to the second.
          const expiresAt = codes[0]?.ms ?? 0;

          const usableAt = (ms: number) =>
            Effect.gen(function* usable() {
              yield* TestClock.setTime(ms);

              return Option.isSome(
                yield* codePrincipal(token, "alumniConsent")
              );
            }).pipe(Effect.provide(TestClock.layer()));

          assert.isTrue(yield* usableAt(expiresAt - 1000));
          assert.isFalse(yield* usableAt(expiresAt + 1000));
        })
    );
  }
);
