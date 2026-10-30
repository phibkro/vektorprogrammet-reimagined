import { assert, layer } from "@effect/vitest";
/**
 * Spec 0009 F3 (the mail), F4 and F7 (the public submit's guards) over PostgreSQL and the real delivery stack.
 *
 * - The journey in the mail: a submit queues one `IssueCode` message that carries no code; the delivery stores the code
 *   `Unsent`, sends the mail and acknowledges it (spec 0024); the link names `/soknad/bekreft`; the code verifies the
 *   address once, and the plaintext lives in the capture mailbox only.
 * - The guards of `/soknad/{department}`: a missing or wrong Turnstile answer and a rate-limited address are refused before
 *   a transaction opens and leave no person, application or message; a post for a department with no open period is
 *   refused; the valid post queues exactly one message.
 */
import { DatabaseLive } from "@vektorprogrammet/db";
import { TestDatabaseUrl } from "@vektorprogrammet/db/testing";
import {
  AdmissionEndpoints,
  CodeToken,
  CurrentPrincipal,
  PersonalDataEndpoints,
  anonymous,
  codePrincipal,
} from "@vektorprogrammet/domain";
import { Cause, Effect, Exit, Layer, Option, Predicate } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { submissionOf } from "../src/server/admissionPost";
import { contactRateLimiterTestLayer } from "../src/server/rateLimit";
import { runCommandOutcome } from "../src/server/runtime";
import {
  CAPTCHA_FIELD,
  TURNSTILE_RESPONSE_FIELD,
  turnstileTestLayer,
} from "../src/server/turnstile";
import { webCryptoLayer } from "../src/server/webCrypto";
import { deliverPending, live } from "./support/deliveryLive";
import { form } from "./support/memory";
import { assertRefused, assertSuccess } from "./support/outcomes";
import { transacted } from "./support/transacted";

const { signal } = new AbortController();

const VALID_TOKEN = "fake-turnstile-token";

/** A department with a field of study and a period that is open now. */
const arrange = Effect.fnUntraced(function* arrange(id: number) {
  const sql = yield* SqlClient;

  yield* sql`insert into department (id, city, email, name, short_name) values (${id}, ${`Soknadby${String(id)}`}, ${`soknad${String(id)}@example.org`}, ${`Søknad ${String(id)}`}, ${`SØK${String(id)}`})`;
  yield* sql`insert into field_of_study (id, department_id, name, short_name) values (${id}, ${id}, 'Linje', 'LIN')`;
  yield* sql`insert into semester (id, term, year) values (${id}, 'VAR', ${3000 + id}) on conflict do nothing`;
  yield* sql`insert into admission_period (department_id, semester_id, starts_at, ends_at) values (${id}, ${id}, now() - interval '1 day', now() + interval '30 days')`;

  return id;
}, Effect.orDie);

const postedForm = (departmentId: number, email: string, token?: string) => {
  const answers = {
    bolk: "Both",
    departmentId: String(departmentId),
    email,
    fieldOfStudyId: String(departmentId),
    name: "Søker Eksempel",
    "source-Web": "on",
    "weekday-Monday": "on",
    yearOfStudy: "2",
  };

  return token === undefined
    ? form(answers)
    : form({ ...answers, [TURNSTILE_RESPONSE_FIELD]: token });
};

const holdings = Effect.gen(function* holdings() {
  const sql = yield* SqlClient;

  const [row] = yield* sql<{
    readonly applications: number;
    readonly outbox: number;
    readonly people: number;
  }>`select (select count(*)::int from application) as applications, (select count(*)::int from outbox) as outbox, (select count(*)::int from person) as people`;

  return row;
}).pipe(Effect.orDie);

layer(live, { excludeTestServices: true })(
  "spec 0009: the application's mail and the public post's guards",
  (it) => {
    it.effect(
      "F3: a submit queues one message with no code; the delivery mails a link that verifies the address once",
      () =>
        Effect.gen(function* journey() {
          const sql = yield* SqlClient;
          const department = yield* arrange(701);

          const receipt = yield* transacted(
            AdmissionEndpoints.submitApplication({
              bolk: "Both",
              departmentId: department,
              doublePosition: false,
              email: "kari.soknad@example.org",
              fieldOfStudyId: department,
              gender: null,
              heardAbout: [],
              name: "Kari Søker",
              specialNeeds: null,
              specialNeedsConsent: false,
              teamInterest: [],
              weekdays: ["Monday"],
              yearOfStudy: 1,
            }).pipe(Effect.provideService(CurrentPrincipal, anonymous))
          );

          assert.strictEqual(receipt.departmentId, department);

          const [queued] = yield* sql<{
            payload: string;
          }>`select payload::text as payload from outbox where kind = 'IssueCode' order by id desc limit 1`;

          assert.include(queued?.payload ?? "", "verifyApplication");

          const [delivered] = yield* deliverPending;
          assert.strictEqual(delivered?._tag, "Delivered");

          const [mail] = yield* sql<{
            text: string;
            recipient: string;
            subject: string;
          }>`select text, recipient, subject from captured_mail order by id desc limit 1`;

          assert.strictEqual(mail?.recipient, "kari.soknad@example.org");
          assert.strictEqual(mail?.subject, "Bekreft e-postadressen din");
          assert.include(mail?.text ?? "", "/soknad/bekreft?kode=");
          assert.include(mail?.text ?? "", "30 dager");

          const found = /[?&]kode=(?<token>c_[A-Za-z0-9_-]{43})/u.exec(
            mail?.text ?? ""
          );

          const token = CodeToken.make(found?.groups?.token ?? "");

          // The plaintext is in the mailbox and nowhere else.
          const [leak] = yield* sql<{
            n: number;
          }>`select count(*)::int as n from outbox where payload::text like ${`%${token}%`}`;

          assert.strictEqual(leak?.n, 0);

          assert.isTrue(
            Option.isSome(yield* codePrincipal(token, "verifyApplication"))
          );

          yield* transacted(
            PersonalDataEndpoints.verifyApplicantEmail({ code: token })
          );

          const [person] = yield* sql<{
            email_verified: boolean;
          }>`select p.email_verified from person p join application a on a.person_id = p.id where a.id = ${receipt.applicationId}`;

          assert.isTrue(person?.email_verified);

          // Used: the same link is refused, and the answer names no reason.
          assert.isTrue(
            Option.isNone(yield* codePrincipal(token, "verifyApplication"))
          );
        })
    );

    it.effect(
      "F4: no Turnstile answer, a wrong one and a rate-limited address are refused before a transaction; the valid post queues one message",
      () =>
        Effect.gen(function* guards() {
          const url = yield* TestDatabaseUrl;
          const department = yield* arrange(702);
          const closed = yield* arrange(703);
          const sql = yield* SqlClient;

          yield* sql`update admission_period set ends_at = now() - interval '1 hour', starts_at = now() - interval '2 days' where department_id = ${closed}`;

          const post = (data: FormData, allowed = 5) => {
            const { command, prepare } = submissionOf(
              data,
              new Headers({ "CF-Connecting-IP": "192.0.2.77" })
            );

            return Effect.promise(() =>
              runCommandOutcome(
                Layer.orDie(
                  Layer.mergeAll(
                    DatabaseLive({ maxConnections: 4, url }),
                    turnstileTestLayer(VALID_TOKEN),
                    contactRateLimiterTestLayer(allowed),
                    webCryptoLayer,
                    Layer.succeed(CurrentPrincipal)(anonymous)
                  )
                ),
                prepare,
                command,
                signal
              )
            );
          };

          const before = yield* holdings;

          const none = yield* post(
            postedForm(department, "a.soknad@example.org")
          );

          assert.isTrue(Predicate.isTagged(none, "Failure"));

          if (
            Predicate.isTagged(none, "Failure") &&
            Predicate.isTagged(none.error, "ValidationFailed")
          ) {
            assert.deepStrictEqual(none.error.issues[0]?.path, [CAPTCHA_FIELD]);
          }

          assert.isTrue(
            Predicate.isTagged(
              yield* post(
                postedForm(department, "b.soknad@example.org", "forged")
              ),
              "Failure"
            )
          );

          assert.deepStrictEqual(yield* holdings, before);

          // A post for a department whose period has ended is refused after the checks, and writes nothing.
          assertRefused(
            yield* post(
              postedForm(closed, "c.soknad@example.org", VALID_TOKEN)
            ),
            "ValidationFailed"
          );

          assert.deepStrictEqual(yield* holdings, before);

          // The control: a valid post stores one person, one application and one message.
          const valid = assertSuccess(
            yield* post(
              postedForm(department, "d.soknad@example.org", VALID_TOKEN)
            )
          );

          assert.strictEqual(valid.enqueued.length, 1);
          const after = yield* holdings;
          assert.strictEqual(after?.people, (before?.people ?? 0) + 1);
          assert.strictEqual(
            after?.applications,
            (before?.applications ?? 0) + 1
          );
          assert.strictEqual(after?.outbox, (before?.outbox ?? 0) + 1);

          // The rate limit: the second post from one address in a window is refused in the same prepare step, before any
          // transaction (the limiter is one instance for the window, so both posts go through one layer).
          const { prepare } = submissionOf(
            postedForm(department, "e.soknad@example.org", VALID_TOKEN),
            new Headers({ "CF-Connecting-IP": "192.0.2.78" })
          );

          const limited = yield* Effect.exit(
            Effect.andThen(prepare, prepare).pipe(
              Effect.provide(
                Layer.mergeAll(
                  turnstileTestLayer(VALID_TOKEN),
                  contactRateLimiterTestLayer(1)
                )
              )
            )
          );

          assert.isTrue(Exit.isFailure(limited));

          assert.isTrue(
            Exit.isFailure(limited) &&
              Option.exists(
                Cause.findErrorOption(limited.cause),
                Predicate.isTagged("RateLimited")
              )
          );

          assert.deepStrictEqual(yield* holdings, after);
        })
    );
  }
);
