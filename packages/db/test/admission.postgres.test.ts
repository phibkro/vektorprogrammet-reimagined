/**
 * Spec 0009 on PostgreSQL: F2 the period's constraints and the race on `(department, semester)` with its control, F4 what a
 * public submit writes (one person, one application, one message) and what a refusal leaves (nothing), F5 the
 * database side of the shared checks, F8 the special-needs text with the consent it rests on, and F11 the machine
 * (`Submitted → Withdrawn` once, by the person's lock, by staff of the department only).
 */
import { assert, layer } from "@effect/vitest";
import {
  AdmissionEndpoints,
  AlreadyExists,
  ApplicationRepository,
  Conflict,
  Forbidden,
  ValidationFailed,
  anonymous,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Exit } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import {
  CLOSES,
  OPENS,
  applicationInput,
  arrange,
  count,
  leaderOf,
  outboxKinds,
  outsiderOf,
  periodInput,
  schedule,
} from "./support/admissionWorld.ts";
import { postgresDatabase } from "./support/database.ts";
import { assertFailedWith, failedWith } from "./support/failures.ts";
import { runAs } from "./support/personalDataActors.ts";
import { race, raceReport } from "./support/race.ts";
import { at } from "./support/retentionRun.ts";
import { asPerson } from "./support/teamsWorld.ts";

const BEFORE = DateTime.makeUnsafe("2027-01-10T08:00:00Z");
const DURING = DateTime.makeUnsafe("2027-03-01T08:00:00Z");
const AFTER = DateTime.makeUnsafe("2027-05-01T08:00:00Z");

/** How many schedules race, and how many rounds, each round on a department of its own. */
const SCHEDULES = 20;
const ROUNDS = 30;

type Arranged = Effect.Success<ReturnType<typeof arrange>>;

/** The instant of a `timestamptz` column as epoch milliseconds, `null` for a null column. */
const epochOf = (value: Date | string | null): number | null =>
  value === null ? null : DateTime.toEpochMillis(DateTime.makeUnsafe(value));

/** A department with a period that is open on `DURING`, and its leader. */
const openDepartment = Effect.fnUntraced(function* openDepartment(tag: string) {
  const fixture: Arranged = yield* arrange(tag);
  const leader = leaderOf(fixture.department.id, fixture.person.id);
  yield* at(BEFORE);
  const period = yield* schedule(leader, periodInput(fixture.department.id));

  return { fixture, leader, period };
});

/** What a refusal must leave alone: the people, the applications and the messages. */
const holdings = Effect.fnUntraced(function* holdings() {
  return {
    applications: yield* count("application"),
    outbox: yield* count("outbox"),
    people: yield* count("person"),
  };
});

const submit = (input: ReturnType<typeof applicationInput>) =>
  runAs(anonymous, AdmissionEndpoints.submitApplication(input));

layer(postgresDatabase({ maxConnections: 40 }), {
  excludeTestServices: true,
})("spec 0009: admission periods and applications", (outer) => {
  outer.layer(TestClock.layer())((it) => {
    it.effect(
      "F2: a period is scheduled once per department and semester; the end must be after the start; only the department's staff schedule",
      () =>
        Effect.gen(function* periods() {
          const sql = yield* SqlClient;
          const fixture: Arranged = yield* arrange("ad1");
          const other: Arranged = yield* arrange("ad1b");
          const leader = leaderOf(fixture.department.id, fixture.person.id);
          yield* at(BEFORE);

          const created = yield* schedule(
            leader,
            periodInput(fixture.department.id)
          );

          assert.strictEqual(created.departmentId, fixture.department.id);

          assertFailedWith(
            yield* Effect.exit(
              schedule(leader, periodInput(fixture.department.id))
            ),
            AlreadyExists,
            "a second period of the department and semester"
          );

          assertFailedWith(
            yield* Effect.exit(
              schedule(leader, periodInput(other.department.id, CLOSES, OPENS))
            ),
            ValidationFailed,
            "an end before the start"
          );

          assertFailedWith(
            yield* Effect.exit(
              schedule(leader, {
                ...periodInput(fixture.department.id),
                semester: { term: "HOST", year: 2031 },
              })
            ),
            ValidationFailed,
            "a semester that is not stored"
          );

          // The other department's leader, and a member of another function, are refused: the boundary is the department's.
          assertFailedWith(
            yield* Effect.exit(
              schedule(
                leaderOf(other.department.id, other.person.id),
                periodInput(fixture.department.id)
              )
            ),
            Forbidden,
            "a leader of another department"
          );

          assertFailedWith(
            yield* Effect.exit(
              schedule(
                outsiderOf(fixture.department.id, other.person.id),
                periodInput(other.department.id)
              )
            ),
            Forbidden,
            "a member of the board"
          );

          const rows = yield* sql<{
            n: number;
          }>`select count(*)::int as n from admission_period where department_id = ${fixture.department.id}`;

          assert.strictEqual(rows[0]?.n, 1);

          const audit = yield* sql<{
            action: string;
          }>`select action from audit_log where entity = 'AdmissionPeriod' and entity_key = ${String(created.id)}`;

          assert.deepStrictEqual(
            Arr.map(audit, (row) => row.action),
            ["admissionPeriod.created"]
          );
        })
    );

    it.effect(
      "F2: extend moves the end later only, while the period has not ended; a period that is not there is refused to everyone",
      () =>
        Effect.gen(function* extension() {
          const { leader, period } = yield* openDepartment("ad2");
          const later = DateTime.add(CLOSES, { days: 7 });
          yield* at(DURING);

          const extended = yield* runAs(
            leader,
            AdmissionEndpoints.extendAdmissionPeriod({
              end: DateTime.formatIso(later),
              id: period.id,
            })
          );

          assert.strictEqual(
            DateTime.toEpochMillis(extended.end),
            DateTime.toEpochMillis(later)
          );
          assert.strictEqual(
            DateTime.toEpochMillis(extended.start),
            DateTime.toEpochMillis(OPENS)
          );

          for (const end of [later, DateTime.add(later, { days: -1 })]) {
            assertFailedWith(
              yield* Effect.exit(
                runAs(
                  leader,
                  AdmissionEndpoints.extendAdmissionPeriod({
                    end: DateTime.formatIso(end),
                    id: period.id,
                  })
                )
              ),
              ValidationFailed,
              "an end that is not later"
            );
          }

          assertFailedWith(
            yield* Effect.exit(
              runAs(
                leader,
                AdmissionEndpoints.extendAdmissionPeriod({
                  end: DateTime.formatIso(DateTime.add(later, { days: 3 })),
                  id: 999_999,
                })
              )
            ),
            Forbidden,
            "a period that is not there"
          );

          yield* at(DateTime.add(later, { days: 1 }));

          assertFailedWith(
            yield* Effect.exit(
              runAs(
                leader,
                AdmissionEndpoints.extendAdmissionPeriod({
                  end: DateTime.formatIso(DateTime.add(later, { days: 9 })),
                  id: period.id,
                })
              )
            ),
            Conflict,
            "a period that has ended"
          );
        })
    );

    it.effect(
      "F2: cancel works before the start and with no application, and is refused when the period is Open, Closed or has an application",
      () =>
        Effect.gen(function* cancellation() {
          const sql = yield* SqlClient;
          const { fixture, leader, period } = yield* openDepartment("ad3");

          const cancel = (id: number) =>
            runAs(leader, AdmissionEndpoints.deleteAdmissionPeriod({ id }));

          // An application refers to the period: refused even though it has not started.
          yield* asPerson(fixture.person.id, (locked) =>
            ApplicationRepository.use((applications) =>
              applications.insert(locked, {
                bolk: "Both",
                doublePosition: false,
                fieldOfStudyId: fixture.fieldOfStudy.id,
                gender: null,
                heardAbout: [],
                periodId: period.id,
                specialNeeds: null,
                teamInterest: [],
                weekdays: ["Monday"],
                yearOfStudy: 1,
              })
            )
          );

          assertFailedWith(
            yield* Effect.exit(cancel(period.id)),
            Conflict,
            "a period with an application"
          );

          yield* at(DURING);
          assertFailedWith(
            yield* Effect.exit(cancel(period.id)),
            Conflict,
            "an Open period"
          );
          yield* at(AFTER);
          assertFailedWith(
            yield* Effect.exit(cancel(period.id)),
            Conflict,
            "a Closed period"
          );

          const rows = yield* sql<{
            n: number;
          }>`select count(*)::int as n from admission_period where id = ${period.id}`;

          assert.strictEqual(rows[0]?.n, 1);

          // A Scheduled period with no application is cancelled, and says so in the audit.
          const lone = yield* arrange("ad3b");
          const loneLeader = leaderOf(lone.department.id, lone.person.id);
          yield* at(BEFORE);

          const scheduled = yield* schedule(
            loneLeader,
            periodInput(lone.department.id)
          );

          yield* runAs(
            loneLeader,
            AdmissionEndpoints.deleteAdmissionPeriod({ id: scheduled.id })
          );

          const gone = yield* sql<{
            n: number;
          }>`select count(*)::int as n from admission_period where id = ${scheduled.id}`;

          assert.strictEqual(gone[0]?.n, 0);

          const audit = yield* sql<{
            action: string;
          }>`select action from audit_log where entity = 'AdmissionPeriod' and entity_key = ${String(scheduled.id)} order by id`;

          assert.deepStrictEqual(
            Arr.map(audit, (row) => row.action),
            ["admissionPeriod.created", "admissionPeriod.deleted"]
          );
        })
    );

    it.effect(
      `F2: ${String(SCHEDULES)} concurrent schedules of one department and semester leave one row and ${String(SCHEDULES - 1)} typed losers, in ${String(ROUNDS)} rounds`,
      () =>
        Effect.gen(function* scheduleRace() {
          const sql = yield* SqlClient;
          yield* at(BEFORE);

          for (const round of Arr.range(1, ROUNDS)) {
            const fixture: Arranged = yield* arrange(`adr${String(round)}`);
            const leader = leaderOf(fixture.department.id, fixture.person.id);

            const exits = yield* race(
              Arr.makeBy(SCHEDULES, () =>
                schedule(leader, periodInput(fixture.department.id))
              )
            );

            const report = raceReport(round, exits);
            assert.strictEqual(
              Arr.filter(exits, Exit.isSuccess).length,
              1,
              report
            );

            assert.isTrue(
              Arr.every(Arr.filter(exits, Exit.isFailure), (loser) =>
                failedWith(loser, AlreadyExists)
              ),
              report
            );

            const rows = yield* sql<{
              n: number;
            }>`select count(*)::int as n from admission_period where department_id = ${fixture.department.id}`;

            assert.strictEqual(rows[0]?.n, 1, report);
          }
        })
    );

    it.effect(
      "F4: a submit in an Open period writes one unverified person, one application and one message that carries no code",
      () =>
        Effect.gen(function* publicSubmit() {
          const sql = yield* SqlClient;
          const { fixture } = yield* openDepartment("ad4");
          yield* at(DURING);
          const before = yield* holdings();

          const receipt = yield* submit(
            applicationInput(
              fixture.department.id,
              fixture.fieldOfStudy.id,
              "kari.ad4@example.org",
              { teamInterest: [fixture.team.id] }
            )
          );

          assert.strictEqual(receipt.departmentId, fixture.department.id);

          const after = yield* holdings();
          assert.strictEqual(after.people, before.people + 1);
          assert.strictEqual(after.applications, before.applications + 1);
          assert.strictEqual(after.outbox, before.outbox + 1);
          assert.deepStrictEqual(Arr.takeRight(yield* outboxKinds(), 1), [
            "IssueCode",
          ]);

          const [row] = yield* sql<{
            readonly email_verified: boolean;
            readonly state: string;
            readonly team_interest: readonly number[];
          }>`select p.email_verified, a.state, a.team_interest from application a join person p on p.id = a.person_id where a.id = ${receipt.applicationId}`;

          assert.strictEqual(row?.email_verified, false);
          assert.strictEqual(row?.state, "Submitted");
          assert.deepStrictEqual(row?.team_interest, [fixture.team.id]);

          // The outbox row names the person and the purpose; the plaintext code does not exist yet (spec 0024).
          const [message] = yield* sql<{
            payload: string;
          }>`select payload::text as payload from outbox order by id desc limit 1`;

          assert.include(message?.payload ?? "", "verifyApplication");
          assert.notInclude(message?.payload ?? "", "kode=");
        })
    );

    it.effect(
      "F4 and F5: a submit that the department does not accept, or whose answers the domain refuses, leaves no person, application or message; the same answers over the department's own choices pass",
      () =>
        Effect.gen(function* refusals() {
          const sql = yield* SqlClient;
          const { fixture } = yield* openDepartment("ad5");
          const stranger: Arranged = yield* arrange("ad5b");
          const email = "ola.ad5@example.org";

          const good = applicationInput(
            fixture.department.id,
            fixture.fieldOfStudy.id,
            email
          );

          const refused = (
            label: string,
            input: ReturnType<typeof applicationInput>
          ) =>
            Effect.gen(function* refusedSubmit() {
              const before = yield* holdings();
              assertFailedWith(
                yield* Effect.exit(submit(input)),
                ValidationFailed,
                label
              );
              assert.deepStrictEqual(yield* holdings(), before, label);
            });

          yield* at(DURING);

          yield* refused(
            "a field of study of another department",
            applicationInput(
              fixture.department.id,
              stranger.fieldOfStudy.id,
              email
            )
          );
          yield* refused("a team of another department", {
            ...good,
            teamInterest: [stranger.team.id],
          });
          yield* refused("year 0", { ...good, yearOfStudy: 0 });
          yield* refused("year 6", { ...good, yearOfStudy: 6 });
          yield* refused("a weekday that does not exist", {
            ...good,
            weekdays: ["Sunday"],
          });
          yield* refused("no weekday", { ...good, weekdays: [] });
          yield* refused("special needs without the consent", {
            ...good,
            specialNeeds: "Rullestol",
            specialNeedsConsent: false,
          });

          yield* sql`update team set active = false where id = ${fixture.team.id}`;
          yield* refused("an inactive team", {
            ...good,
            teamInterest: [fixture.team.id],
          });

          // Outside the window: before it opens and after it closes.
          yield* at(BEFORE);
          yield* refused("before the period opens", good);
          yield* at(AFTER);
          yield* refused("after the period closes", good);

          // The control: the same answers, over the department's own choices, in the window, are accepted.
          yield* at(DURING);
          const before = yield* holdings();
          yield* submit(good);
          assert.strictEqual(
            (yield* holdings()).applications,
            before.applications + 1
          );
        })
    );

    it.effect(
      "F8: special needs are stored with the version and the time of the consent they rest on, and with no text nothing is stored",
      () =>
        Effect.gen(function* consent() {
          const sql = yield* SqlClient;
          const { fixture } = yield* openDepartment("ad6");
          yield* at(DURING);

          const withText = yield* submit(
            applicationInput(
              fixture.department.id,
              fixture.fieldOfStudy.id,
              "a.ad6@example.org",
              {
                specialNeeds: "Trenger ramme",
                specialNeedsConsent: true,
              }
            )
          );

          const without = yield* submit(
            applicationInput(
              fixture.department.id,
              fixture.fieldOfStudy.id,
              "b.ad6@example.org"
            )
          );

          const rows = yield* sql<{
            readonly at: Date | null;
            readonly id: number;
            readonly text: string | null;
            readonly version: number | null;
          }>`select id, special_needs as text, special_needs_consent_version as version, special_needs_consented_at as at from application where id in (${withText.applicationId}, ${without.applicationId}) order by id`;

          const [first, second] = rows;
          assert.strictEqual(first?.text, "Trenger ramme");
          assert.strictEqual(first?.version, 1);
          assert.strictEqual(
            epochOf(first?.at ?? null),
            DateTime.toEpochMillis(DURING)
          );
          assert.deepStrictEqual(
            [second?.text, second?.version, second?.at],
            [null, null, null]
          );
        })
    );

    it.effect(
      "F5: the unique key is the backstop: a second application of one person in one period is refused, and of twenty concurrent inserts one is stored",
      () =>
        Effect.gen(function* backstop() {
          const sql = yield* SqlClient;
          const { fixture, period } = yield* openDepartment("ad7");

          const draft = {
            bolk: "Both",
            doublePosition: false,
            fieldOfStudyId: fixture.fieldOfStudy.id,
            gender: null,
            heardAbout: [],
            periodId: period.id,
            specialNeeds: null,
            teamInterest: [],
            weekdays: ["Monday"],
            yearOfStudy: 1,
          } as const;

          const insert = asPerson(fixture.person.id, (locked) =>
            ApplicationRepository.use((applications) =>
              applications.insert(locked, draft)
            )
          );

          const exits = yield* race(Arr.makeBy(SCHEDULES, () => insert));

          assert.strictEqual(
            Arr.filter(exits, Exit.isSuccess).length,
            1,
            raceReport(0, exits)
          );

          assert.isTrue(
            Arr.every(Arr.filter(exits, Exit.isFailure), (loser) =>
              failedWith(loser, AlreadyExists)
            )
          );

          const rows = yield* sql<{
            n: number;
          }>`select count(*)::int as n from application where person_id = ${fixture.person.id}`;

          assert.strictEqual(rows[0]?.n, 1);
        })
    );

    it.effect(
      "F11: an application is withdrawn once, by the staff of its department; a withdrawn one cannot be withdrawn again and nobody else may",
      () =>
        Effect.gen(function* withdrawal() {
          const sql = yield* SqlClient;
          const { fixture, leader } = yield* openDepartment("ad8");
          const other: Arranged = yield* arrange("ad8b");
          yield* at(DURING);

          const receipt = yield* submit(
            applicationInput(
              fixture.department.id,
              fixture.fieldOfStudy.id,
              "w.ad8@example.org"
            )
          );

          const withdraw = (principal: Parameters<typeof runAs>[0]) =>
            runAs(
              principal,
              AdmissionEndpoints.withdrawApplication({
                id: receipt.applicationId,
              })
            );

          assertFailedWith(
            yield* Effect.exit(
              withdraw(leaderOf(other.department.id, other.person.id))
            ),
            Forbidden,
            "a leader of another department"
          );

          assertFailedWith(
            yield* Effect.exit(withdraw(anonymous)),
            Forbidden,
            "no one signed in"
          );

          yield* withdraw(leader);

          assertFailedWith(
            yield* Effect.exit(withdraw(leader)),
            Conflict,
            "withdrawing twice"
          );

          const [row] = yield* sql<{
            state: string;
          }>`select state from application where id = ${receipt.applicationId}`;

          assert.strictEqual(row?.state, "Withdrawn");

          assertFailedWith(
            yield* Effect.exit(
              runAs(
                leader,
                AdmissionEndpoints.withdrawApplication({ id: 999_999 })
              )
            ),
            Forbidden,
            "an application that is not there"
          );

          const audit = yield* sql<{
            action: string;
          }>`select action from audit_log where entity = 'Application' and entity_key = ${String(receipt.applicationId)}`;

          assert.deepStrictEqual(
            Arr.map(audit, (entry) => entry.action),
            ["application.withdrawn"]
          );
        })
    );

    it.effect(
      "F7: staff register in a period of the current semester outside its window, not twice for one address, and not in another semester or department",
      () =>
        Effect.gen(function* registration() {
          const { fixture, leader, period } = yield* openDepartment("ad9");
          const other: Arranged = yield* arrange("ad9b");

          const register = (
            principal: Parameters<typeof runAs>[0],
            email: string,
            periodId: number = period.id
          ) =>
            runAs(
              principal,
              AdmissionEndpoints.registerApplication({
                ...applicationInput(
                  fixture.department.id,
                  fixture.fieldOfStudy.id,
                  email
                ),
                periodId,
              })
            );

          // Before the window opens, in the same semester: allowed for staff (a stand, UNMATCHED-153).
          yield* at(BEFORE);
          const first = yield* register(leader, "s.ad9@example.org");
          assert.strictEqual(first.departmentId, fixture.department.id);

          assertFailedWith(
            yield* Effect.exit(register(leader, "s.ad9@example.org")),
            Conflict,
            "the same address in the period"
          );
          yield* register(leader, "t.ad9@example.org");

          assertFailedWith(
            yield* Effect.exit(
              register(
                leaderOf(other.department.id, other.person.id),
                "u.ad9@example.org"
              )
            ),
            Forbidden,
            "a leader of another department"
          );

          assertFailedWith(
            yield* Effect.exit(
              register(
                outsiderOf(fixture.department.id, other.person.id),
                "v.ad9@example.org"
              )
            ),
            Forbidden,
            "a member of another function"
          );

          // The next semester's period is not registrable in this one.
          yield* at(DateTime.makeUnsafe("2027-09-01T08:00:00Z"));
          assertFailedWith(
            yield* Effect.exit(register(leader, "w.ad9@example.org")),
            ValidationFailed,
            "a period of another semester"
          );

          assertFailedWith(
            yield* Effect.exit(register(leader, "x.ad9@example.org", 999_999)),
            Forbidden,
            "a period that is not there"
          );
        })
    );

    it.effect(
      "F4: a missing period of the department never reaches the repository: the department's own state decides",
      () =>
        Effect.gen(function* noPeriod() {
          const fixture: Arranged = yield* arrange("ad10");
          yield* at(DURING);
          const before = yield* holdings();

          assertFailedWith(
            yield* Effect.exit(
              submit(
                applicationInput(
                  fixture.department.id,
                  fixture.fieldOfStudy.id,
                  "n.ad10@example.org"
                )
              )
            ),
            ValidationFailed,
            "a department with no period"
          );

          assert.deepStrictEqual(yield* holdings(), before);
        })
    );
  });
});

layer(postgresDatabase({ maxConnections: 40 }), {
  excludeTestServices: true,
})(
  "spec 0009 F2 negative control: the race without the unique key",
  (outer) => {
    outer.layer(TestClock.layer())((it) => {
      it.effect(
        "without admission_period_department_semester_unique the same race writes more than one row",
        () =>
          Effect.gen(function* withoutKey() {
            const sql = yield* SqlClient;
            yield* sql`alter table admission_period drop constraint admission_period_department_semester_unique`;
            yield* at(BEFORE);
            const fixture: Arranged = yield* arrange("adcontrol");
            const leader = leaderOf(fixture.department.id, fixture.person.id);

            yield* race(
              Arr.makeBy(SCHEDULES, () =>
                schedule(leader, periodInput(fixture.department.id))
              )
            );

            const rows = yield* sql<{
              n: number;
            }>`select count(*)::int as n from admission_period where department_id = ${fixture.department.id}`;

            assert.isAbove(rows[0]?.n ?? 0, 1);
          })
      );
    });
  }
);
