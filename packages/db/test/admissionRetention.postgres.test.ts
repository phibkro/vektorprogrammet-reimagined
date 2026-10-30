/**
 * Spec 0009 F9: an application is deleted six months after the end of its admission period (`Periods.applicationAfterPeriodEnd`,
 * proposed), whether it was submitted or withdrawn, and not a day before; a repeat run changes nothing; an application of a
 * later period is kept; the export of a person lists their applications and no one else's; an erasure on their behalf
 * deletes them at once.
 */
import { assert, layer } from "@effect/vitest";
import type { AdmissionPeriodId } from "@vektorprogrammet/domain";
import {
  AdmissionEndpoints,
  ApplicationRepository,
  PersonalDataEndpoints,
  Periods,
  SemesterRepository,
  afterDuration,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import {
  CLOSES,
  applicationDraft,
  arrange,
  count,
  leaderOf,
  periodInput,
  schedule,
} from "./support/admissionWorld.ts";
import { postgresJobDatabase } from "./support/database.ts";
import { encodeJson } from "./support/json.ts";
import {
  adminPrincipal,
  runAs,
  selfPrincipal,
} from "./support/personalDataActors.ts";
import { at, runRetention } from "./support/retentionRun.ts";
import { asPerson } from "./support/teamsWorld.ts";

const BEFORE = DateTime.makeUnsafe("2027-01-10T08:00:00Z");

const day = (instant: DateTime.Utc, days: number) =>
  DateTime.add(instant, { days });

/** The instant at which the period that ended at `CLOSES` is six months past. */
const DUE = afterDuration(CLOSES, Periods.applicationAfterPeriodEnd.duration);

type Arranged = Effect.Success<ReturnType<typeof arrange>>;

/** An application of `fixture.person` in the period, as a fixture writes it outside a command. */
const apply = (fixture: Arranged, periodId: AdmissionPeriodId) =>
  asPerson(fixture.person.id, (locked) =>
    ApplicationRepository.use((applications) =>
      applications.insert(
        locked,
        applicationDraft(fixture.fieldOfStudy.id, periodId, {
          consentVersion: 1,
          consentedAt: BEFORE,
          text: `behov ${String(periodId)}`,
        })
      )
    )
  );

layer(postgresJobDatabase("Apply"), { excludeTestServices: true })(
  "spec 0009 F9: applications are retained until six months after their period",
  (outer) => {
    outer.layer(TestClock.layer())((it) => {
      it.effect(
        "the nightly run deletes a submitted and a withdrawn application exactly when the period is six months past, and keeps a later period's",
        () =>
          Effect.gen(function* retention() {
            const sql = yield* SqlClient;
            const submitted: Arranged = yield* arrange("rt1");
            const withdrawn: Arranged = yield* arrange("rt1b");
            yield* (yield* SemesterRepository).ensure({
              term: "HOST",
              year: 2027,
            });
            yield* at(BEFORE);

            const leaderOne = leaderOf(
              submitted.department.id,
              submitted.person.id
            );

            const leaderTwo = leaderOf(
              withdrawn.department.id,
              withdrawn.person.id
            );

            const ended = yield* schedule(
              leaderOne,
              periodInput(submitted.department.id)
            );

            const endedToo = yield* schedule(
              leaderTwo,
              periodInput(withdrawn.department.id)
            );

            const later = yield* runAs(
              leaderOne,
              AdmissionEndpoints.createAdmissionPeriod({
                departmentId: submitted.department.id,
                end: "2027-11-30T22:00:00Z",
                semester: { term: "HOST", year: 2027 },
                start: "2027-09-01T08:00:00Z",
              })
            );

            const first = yield* apply(submitted, ended.id);
            const second = yield* apply(withdrawn, endedToo.id);
            yield* apply(submitted, later.id);

            yield* runAs(
              leaderTwo,
              AdmissionEndpoints.withdrawApplication({ id: second.id })
            );

            assert.strictEqual(yield* count("application"), 3);

            yield* at(day(DUE, -1));
            yield* runRetention;
            assert.strictEqual(
              yield* count("application"),
              3,
              "a day before: nothing is due"
            );

            yield* at(DateTime.subtract(DUE, { milliseconds: 1 }));
            yield* runRetention;
            assert.strictEqual(
              yield* count("application"),
              3,
              "a millisecond before the retention ends: nothing is due"
            );

            // At the instant itself (an instant is read at its millisecond) the two applications of the ended periods are due.
            yield* at(DUE);
            yield* runRetention;

            const left = yield* sql<{
              id: number;
              period_id: number;
            }>`select id, period_id from application order by id`;

            assert.deepStrictEqual(
              Arr.map(left, (row) => row.period_id),
              [later.id],
              "the two applications of the ended periods are gone"
            );

            assert.notInclude(
              Arr.map(left, (row) => row.id),
              first.id
            );

            yield* at(DateTime.add(day(DUE, 1), { hours: 3 }));
            yield* runRetention;
            assert.strictEqual(
              yield* count("application"),
              1,
              "a repeat run changes nothing"
            );
          })
      );

      it.effect(
        "the export of a person lists their applications, and an erasure on their behalf deletes them",
        () =>
          Effect.gen(function* exportAndErase() {
            const fixture: Arranged = yield* arrange("rt2");
            const stranger: Arranged = yield* arrange("rt2b");
            yield* at(BEFORE);

            const period = yield* schedule(
              leaderOf(fixture.department.id, fixture.person.id),
              periodInput(fixture.department.id)
            );

            const strangerPeriod = yield* schedule(
              leaderOf(stranger.department.id, stranger.person.id),
              periodInput(stranger.department.id)
            );

            yield* apply(fixture, period.id);
            yield* apply(stranger, strangerPeriod.id);

            const exported = yield* runAs(
              selfPrincipal(fixture.person.id),
              PersonalDataEndpoints.exportMyData({
                personId: fixture.person.id,
              })
            );

            const rows = exported.tables.application ?? [];
            assert.strictEqual(rows.length, 1);
            const listed = yield* encodeJson(rows);
            assert.include(listed, `behov ${String(period.id)}`);

            assert.notInclude(
              yield* encodeJson(exported),
              `behov ${String(strangerPeriod.id)}`
            );

            yield* runAs(
              adminPrincipal(stranger.person.id),
              PersonalDataEndpoints.erasePerson({ personId: fixture.person.id })
            );

            const sql = yield* SqlClient;

            const mine = yield* sql<{
              n: number;
            }>`select count(*)::int as n from application where person_id = ${fixture.person.id}`;

            const theirs = yield* sql<{
              n: number;
            }>`select count(*)::int as n from application where person_id = ${stranger.person.id}`;

            assert.strictEqual(mine[0]?.n, 0);
            assert.strictEqual(theirs[0]?.n, 1);
          })
      );
    });
  }
);
