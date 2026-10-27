/**
 * Spec 0007b falsifier 5: the alumni consent. When a person's last engagement has ended and no other is current, one run
 * of the job asks for one e-mail (an `IssueCode` message in the outbox, written in the run's transaction) and a second
 * run asks for none. Each box is answered through one command path, by Min side and by the code of the e-mail:
 * "news yes, keep no" is two records with the text version and the time, and withdrawing one leaves the other. The code
 * lives 60 days, can be used again, and opens nothing but the answer.
 */
import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import {
  CodeRepository,
  CurrentPrincipal,
  PersonId,
  PersonalDataEndpoints,
  alumniConsentJob,
  codePrincipal,
  mintCode,
  systemPrincipal,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { transactional } from "../src/index.ts";
import { postgresDatabase } from "./support/database.ts";
import { runAs, selfPrincipal } from "./support/personalDataActors.ts";
import { nothing, seedPerson } from "./support/personData.ts";
import type { Seeded } from "./support/personData.ts";
import { snapshot } from "./support/snapshot.ts";
import { asPerson } from "./support/teamsWorld.ts";

/** An ordinary day in the middle of the spring semester of 2026 (Oslo winter time). */
const NOW = DateTime.makeUnsafe("2026-03-01T12:00:00Z");

const at = (instant: DateTime.Utc) =>
  TestClock.setTime(DateTime.toEpochMillis(instant));

/** The job as the Worker's tick runs it: in a transaction, as `System("alumniConsent")`. */
const runAlumniJob = transactional(
  Effect.provideService(
    alumniConsentJob,
    CurrentPrincipal,
    systemPrincipal("alumniConsent")
  )
);

/** A semester: Vår or Høst of a year. */
type Term = readonly ["HOST" | "VAR", number];

/** A membership from `start` to `end` (the same semester when the end is left out). */
const memberOf = (who: Seeded, start: Term, end: Term = start) =>
  Effect.flatMap(
    SqlClient,
    (sql) =>
      sql`insert into membership (end_term, end_year, person_id, position_id, start_term, start_year, team_id)
        values (${end[0]}, ${end[1]}, ${who.personId}, ${who.positionId}, ${start[0]}, ${start[1]}, ${who.teamId})`
  );

const issuedFor = Effect.fnUntraced(function* issuedFor() {
  const sql = yield* SqlClient;

  const rows = yield* sql<{
    readonly person: number;
    readonly purpose: string;
  }>`
    select (payload ->> 'personId')::int as person, payload ->> 'purpose' as purpose
    from outbox where kind = 'IssueCode' order by id`;

  return Arr.map(rows, (row) => [row.person, row.purpose] as const);
});

/** What `issuedFor` lists once the job has asked each of `people`, in that order. */
const asked = (...people: readonly Seeded[]) =>
  Arr.map(people, (person) => [person.personId, "alumniConsent"] as const);

const recordsOf = Effect.fnUntraced(function* recordsOf(personId: number) {
  const sql = yield* SqlClient;

  const rows = yield* sql<{
    readonly given_at: Date;
    readonly kind: string;
    readonly text_version: number;
    readonly withdrawn_at: Date | null;
  }>`select kind, given_at, withdrawn_at, text_version from consent
    where person_id = ${personId} order by kind`;

  return Arr.map(rows, (row) => ({
    given: row.given_at.toISOString(),
    kind: row.kind,
    version: row.text_version,
    withdrawn:
      row.withdrawn_at === null ? null : row.withdrawn_at.toISOString(),
  }));
});

/** One consent record as `recordsOf` reads it: version 1 of the text, given at `given`, withdrawn at `withdrawn` or not. */
const record = (
  kind: string,
  given: DateTime.Utc,
  withdrawn: DateTime.Utc | null = null
) => ({
  given: DateTime.formatIso(given),
  kind,
  version: 1,
  withdrawn: withdrawn === null ? null : DateTime.formatIso(withdrawn),
});

/** What the answers of one person wrote to the audit log, oldest first. */
const auditActions = Effect.fnUntraced(function* auditActions(
  personId: number
) {
  const sql = yield* SqlClient;

  const rows = yield* sql<{ readonly action: string }>`
    select action from audit_log
    where entity = 'Consent' and entity_key like ${`${personId}:%`} order by id`;

  return Arr.map(rows, (row) => row.action);
});

layer(postgresDatabase().pipe(Layer.provideMerge(NodeServices.layer)), {
  excludeTestServices: true,
})("spec 0007b falsifier 5: the alumni consent", (outer) => {
  outer.layer(TestClock.layer())((it) => {
    it.effect(
      "one run asks once for each person who has left and is not engaged any more, and a second run asks for nobody",
      () =>
        Effect.gen(function* oneRequest() {
          const sql = yield* SqlClient;
          yield* at(NOW);

          // Left at the end of Høst 2025 (1 January 2026): due.
          const alma = yield* seedPerson("almaa", nothing, NOW);
          yield* memberOf(alma, ["HOST", 2025]);

          // Engaged: Vår 2026 is current. Once its date has passed, he has left.
          const bjorn = yield* seedPerson("bjornb", nothing, NOW);
          yield* memberOf(bjorn, ["HOST", 2025]);
          yield* memberOf(bjorn, ["VAR", 2026]);

          // Engaged, and with Høst 2026 planned. Ending that engagement early makes the date of the end earlier.
          const cecilie = yield* seedPerson("cecilc", nothing, NOW);
          yield* memberOf(cecilie, ["HOST", 2025]);
          yield* memberOf(cecilie, ["VAR", 2026], ["HOST", 2026]);

          // Never engaged.
          yield* seedPerson("dagdd", nothing, NOW);

          // Left long ago: the person core's year is over, and asking now would reach someone about to be anonymised.
          const eli = yield* seedPerson("elieli", nothing, NOW);
          yield* memberOf(eli, ["HOST", 2023]);

          const first = yield* runAlumniJob;
          assert.strictEqual(first.sent, 1);
          assert.deepStrictEqual(yield* issuedFor(), asked(alma));

          const afterFirst = yield* snapshot;
          const second = yield* runAlumniJob;

          assert.strictEqual(second.sent, 0);
          assert.deepStrictEqual(yield* snapshot, afterFirst);
          assert.deepStrictEqual(yield* issuedFor(), asked(alma));

          // The date passes: Vår 2026 ended on 1 August. Bjørn has left; Cecilie still has Høst 2026.
          yield* at(DateTime.makeUnsafe("2026-09-01T12:00:00Z"));
          assert.strictEqual((yield* runAlumniJob).sent, 1);

          assert.deepStrictEqual(yield* issuedFor(), asked(alma, bjorn));

          // The engagement is ended early (a command that shortens it): now Cecilie has left too.
          yield* sql`update membership set end_term = 'VAR', end_year = 2026
            where person_id = ${cecilie.personId} and end_term = 'HOST' and end_year = 2026`;

          assert.strictEqual((yield* runAlumniJob).sent, 1);

          assert.deepStrictEqual(
            yield* issuedFor(),
            asked(alma, bjorn, cecilie)
          );

          // Each request is recorded once, with the engagement end it was made for.
          const [requests] = yield* sql<{
            readonly n: number;
          }>`select count(*)::int as n from alumni_request`;

          assert.strictEqual(requests?.n, 3);

          // Nobody is asked twice, whenever the job runs.
          yield* at(DateTime.makeUnsafe("2026-10-01T12:00:00Z"));
          assert.strictEqual((yield* runAlumniJob).sent, 0);
        })
    );

    it.effect(
      "a person is asked until one year after leaving, and not from that second on",
      () =>
        Effect.gen(function* boundary() {
          // Høst 2024 ended on 1 January 2025 (Oslo): the year after it ends at 23:00 UTC on 31 December 2025.
          const closes = DateTime.makeUnsafe("2025-12-31T23:00:00Z");

          yield* at(DateTime.subtract(closes, { seconds: 1 }));
          const inside = yield* seedPerson("insidei", nothing, NOW);
          yield* memberOf(inside, ["HOST", 2024]);

          assert.strictEqual((yield* runAlumniJob).sent, 1);

          yield* at(closes);
          const outside = yield* seedPerson("outsideo", nothing, NOW);
          yield* memberOf(outside, ["HOST", 2024]);

          assert.strictEqual((yield* runAlumniJob).sent, 0);

          assert.notInclude(
            Arr.map(yield* issuedFor(), ([person]) => person),
            outside.personId
          );
        })
    );

    it.effect(
      "the two boxes are answered by Min side and by the code through one path: news yes and keep no are two records, and withdrawing one leaves the other",
      () =>
        Effect.gen(function* answers() {
          yield* at(NOW);
          const alma = yield* seedPerson("answera", nothing, NOW);
          const me = selfPrincipal(alma.personId);

          const answer = (payload: {
            readonly keepDetails?: boolean;
            readonly news?: boolean;
          }) =>
            runAs(
              me,
              PersonalDataEndpoints.setAlumniConsent({
                personId: alma.personId,
                ...payload,
              })
            );

          const t1 = DateTime.add(NOW, { hours: 1 });
          yield* at(t1);

          // "News yes, keep no": two records, each with the version of the text and the time.
          const summary = yield* answer({ keepDetails: false, news: true });

          assert.deepStrictEqual(summary, {
            keepDetails: "no",
            news: "yes",
            photo: null,
          });

          assert.deepStrictEqual(yield* recordsOf(alma.personId), [
            record("keepDetails", t1, t1),
            record("news", t1),
          ]);

          // Clicking the same answer again writes nothing: the first time stays on the record.
          const before = yield* snapshot;
          yield* at(DateTime.add(NOW, { hours: 2 }));
          yield* answer({ news: true });
          assert.deepStrictEqual(yield* snapshot, before);

          // Withdrawing one leaves the other.
          const t2 = DateTime.add(NOW, { hours: 3 });
          yield* at(t2);
          yield* answer({ news: false });

          assert.deepStrictEqual(yield* recordsOf(alma.personId), [
            record("keepDetails", t1, t1),
            record("news", t1, t2),
          ]);

          assert.deepStrictEqual(yield* auditActions(alma.personId), [
            "consent.withdrawn",
            "consent.given",
            "consent.withdrawn",
          ]);
        })
    );

    it.effect(
      "the code of the e-mail answers the same boxes through the same path, can be used again within its 60 days, and opens nothing else",
      () =>
        Effect.gen(function* byCode() {
          yield* at(NOW);
          const alma = yield* seedPerson("codea", nothing, NOW);
          const kari = yield* seedPerson("codek", nothing, NOW);
          const codes = yield* CodeRepository;
          const minted = yield* mintCode().pipe(Effect.orDie);
          const expires = DateTime.add(NOW, { days: 60 });

          // What the delivery of the e-mail does: it mints the code and stores its hash for the person.
          yield* asPerson(PersonId.make(alma.personId), (locked) =>
            codes.replace(locked, {
              expiresAt: expires,
              hash: minted.hash,
              purpose: "alumniConsent",
            })
          );

          const answerWith = (payload: {
            readonly keepDetails?: boolean;
            readonly news?: boolean;
          }) =>
            transactional(
              PersonalDataEndpoints.answerAlumniConsent({
                code: minted.token,
                ...payload,
              })
            );

          const tFirst = DateTime.add(NOW, { days: 1 });
          yield* at(tFirst);

          const first = yield* answerWith({ keepDetails: true, news: false });
          assert.deepStrictEqual(first, {
            keepDetails: "yes",
            news: "no",
            photo: null,
          });

          // Reusable: a mistake can be corrected with the same code, and it ends nothing.
          const tSecond = DateTime.add(NOW, { days: 30 });
          yield* at(tSecond);

          const second = yield* answerWith({ news: true });
          assert.deepStrictEqual(second, {
            keepDetails: "yes",
            news: "yes",
            photo: null,
          });

          assert.deepStrictEqual(yield* recordsOf(alma.personId), [
            {
              given: DateTime.formatIso(tFirst),
              kind: "keepDetails",
              version: 1,
              withdrawn: null,
            },
            {
              given: DateTime.formatIso(tSecond),
              kind: "news",
              version: 1,
              withdrawn: null,
            },
          ]);

          // It answers the code's own person's record and nobody else's: Kari has no record.
          assert.deepStrictEqual(yield* recordsOf(kari.personId), []);

          // It opens nothing but the answer: not Min side's command, not an erasure, not an export.
          const principal = yield* Effect.fromOption(
            yield* codePrincipal(minted.token, "alumniConsent")
          ).pipe(Effect.orDie);

          const failsAsCode = <A, E, R>(attempt: Effect.Effect<A, E, R>) =>
            Effect.map(
              Effect.exit(
                transactional(
                  Effect.provideService(attempt, CurrentPrincipal, principal)
                )
              ),
              Exit.isFailure
            );

          const failures = [
            yield* failsAsCode(
              PersonalDataEndpoints.setAlumniConsent({
                keepDetails: true,
                personId: alma.personId,
              })
            ),
            yield* failsAsCode(
              PersonalDataEndpoints.erasePerson({ personId: alma.personId })
            ),
            yield* failsAsCode(
              PersonalDataEndpoints.exportMyData({ personId: alma.personId })
            ),
          ];

          assert.deepStrictEqual(failures, [true, true, true]);

          // After its 60 days it is dead.
          yield* at(DateTime.add(expires, { seconds: 1 }));
          const late = yield* Effect.exit(answerWith({ news: false }));
          assert.isTrue(Exit.isFailure(late));
        })
    );
  });
});
