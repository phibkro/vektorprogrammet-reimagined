/**
 * Domain commands from `@vektorprogrammet/domain` against `DatabaseLive` and
 * `transactional` on real PostgreSQL, asserting the persisted rows, audit
 * entries and outbox rows.
 */
import { assert, layer } from "@effect/vitest";
import {
  ContactEndpoints,
  CurrentPrincipal,
  DepartmentRepository,
  OutboxMessage,
  anonymous,
  semesterJob,
  systemPrincipal,
} from "@vektorprogrammet/domain";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  Array as Arr,
  DateTime,
  Effect,
  Order,
  Predicate,
  Schema,
  pipe,
} from "effect";
import { TestClock } from "effect/testing";

import { transactional } from "../src/index.ts";
import * as schema from "../src/schema.ts";
import { Drizzle, postgresDatabase } from "./support/database.ts";
import { AT, departmentDraft, slackChannel } from "./support/fixtures.ts";

/** The semester job as the Worker's `scheduled` handler runs it: in a transaction, as `System("semesters")`. */
const ensureScheduledSemesters = transactional(
  Effect.provideService(
    semesterJob,
    CurrentPrincipal,
    systemPrincipal("semesters")
  )
);

/** A visitor submits the contact form: nobody is signed in. */
const asVisitor = Effect.provideService(CurrentPrincipal, anonymous);

const auditRows = Effect.fnUntraced(function* auditRows(
  entity: string,
  entityKey: string
) {
  const db = yield* Drizzle;

  return yield* db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.entity, entity),
        eq(schema.auditLog.entityKey, entityKey)
      )
    );
});

const decodeMessage = Schema.decodeUnknownEffect(OutboxMessage);

const semesterRows = Effect.gen(function* semesterRows() {
  const db = yield* Drizzle;

  return yield* db.select().from(schema.semester);
});

/** The earlier tests of this suite created semesters: every job test starts from an empty table. */
const emptySemesterTable = Effect.gen(function* emptySemesterTable() {
  const db = yield* Drizzle;
  yield* db.delete(schema.semester);
});

const labelsOf = (rows: readonly { term: string; year: number }[]) =>
  Arr.sort(
    Arr.map(rows, (row) => `${row.term} ${row.year}`),
    Order.String
  );

/** Falsifier 2: the instant the job runs at (an Oslo offset) and the two semesters it leaves. */
const JOB_BOUNDARIES = [
  {
    expected: ["HOST 2026", "VAR 2026"],
    now: "2026-07-31T23:59:59+02:00",
  },
  {
    expected: ["HOST 2026", "VAR 2027"],
    now: "2026-08-01T00:00:00+02:00",
  },
  {
    expected: ["HOST 2026", "VAR 2027"],
    now: "2026-12-31T23:59:59+01:00",
  },
  {
    expected: ["HOST 2027", "VAR 2027"],
    now: "2027-01-01T00:00:00+01:00",
  },
];

layer(postgresDatabase(), { excludeTestServices: true })(
  "domain commands on PostgreSQL",
  (outerTest) => {
    outerTest.layer(TestClock.layer())((it) => {
      it.effect(
        "RULE-237: on an empty table one job run leaves exactly the current and the next semester; a second run changes nothing",
        () =>
          Effect.gen(function* effectProgram() {
            // 2026-10-15 in Oslo is Høst 2026 (RULE-033); its successor is Vår 2027 (RULE-050).
            yield* TestClock.setTime(DateTime.toEpochMillis(AT));
            yield* emptySemesterTable;

            const first = yield* ensureScheduledSemesters;
            const rows = yield* semesterRows;

            assert.deepStrictEqual(labelsOf(rows), ["HOST 2026", "VAR 2027"]);
            assert.deepStrictEqual(
              Arr.sort([first.current.id, first.next.id], Order.Number),
              Arr.sort(
                Arr.map(rows, (row) => row.id),
                Order.Number
              )
            );

            const second = yield* ensureScheduledSemesters;

            assert.deepStrictEqual(second, first);
            assert.deepStrictEqual(yield* semesterRows, rows);
            // The job writes no audit entry: a semester row is not a person's change.
            assert.strictEqual(
              (yield* auditRows("Semester", String(first.current.id))).length,
              0
            );
          })
      );

      it.effect(
        "RULE-237: 20 concurrent job runs on an empty table still leave exactly two rows, and every run saw the same two",
        () =>
          Effect.gen(function* effectProgram() {
            yield* TestClock.setTime(DateTime.toEpochMillis(AT));
            yield* emptySemesterTable;

            const runs = yield* Effect.all(
              Arr.makeBy(20, () => ensureScheduledSemesters),
              { concurrency: "unbounded" }
            );

            const rows = yield* semesterRows;

            assert.deepStrictEqual(labelsOf(rows), ["HOST 2026", "VAR 2027"]);
            assert.isTrue(
              Arr.every(
                runs,
                (run) =>
                  Arr.some(rows, (row) => row.id === run.current.id) &&
                  Arr.some(rows, (row) => row.id === run.next.id)
              )
            );
          })
      );

      it.effect.each(JOB_BOUNDARIES)(
        "RULE-237, RULE-033: at $now the job ensures $expected",
        ({ now, expected }) =>
          Effect.gen(function* effectProgram() {
            yield* TestClock.setTime(
              DateTime.toEpochMillis(DateTime.makeUnsafe(now))
            );
            yield* emptySemesterTable;
            yield* ensureScheduledSemesters;

            assert.deepStrictEqual(labelsOf(yield* semesterRows), expected);
          })
      );

      it.effect(
        "RULE-249: submitContact enqueues four messages in order: department e-mail, receipt, department Slack, #notifications",
        () =>
          Effect.gen(function* effectProgram() {
            yield* TestClock.setTime(DateTime.toEpochMillis(AT));

            const department = yield* (yield* DepartmentRepository).create(
              departmentDraft("Gjøvik", {
                slackChannel: slackChannel("avdeling-gjovik"),
              })
            );

            const receipt = yield* transactional(
              ContactEndpoints.submitContact({
                departmentId: department.id,
                email: "besoker@innsender.example",
                message: "Hei, når åpner opptaket?",
                name: "Testperson",
                subject: "Spørsmål",
              }).pipe(asVisitor)
            );

            assert.strictEqual(receipt.messageIds.length, 4);

            const db = yield* Drizzle;

            const rows = yield* db
              .select()
              .from(schema.outbox)
              .where(
                inArray(
                  schema.outbox.id,
                  pipe(receipt.messageIds, Arr.map(Number))
                )
              )
              .orderBy(asc(schema.outbox.id));

            assert.deepStrictEqual(
              pipe(
                rows,
                Arr.map((row) => String(row.id))
              ),
              [...receipt.messageIds]
            );
            assert.isTrue(
              pipe(
                rows,
                Arr.every(
                  (row) => row.status === "pending" && row.attempts === 0
                )
              )
            );

            const messages = yield* Effect.all(
              pipe(
                rows,
                Arr.map((row) => decodeMessage(row.payload))
              )
            );

            assert.deepStrictEqual(
              pipe(
                messages,
                Arr.map((message) => {
                  if (Predicate.isTagged(message, "Email")) {
                    return `Email:${message.to}`;
                  }

                  if (Predicate.isTagged(message, "SlackPost")) {
                    return `SlackPost:${message.target._tag}`;
                  }

                  return message._tag;
                })
              ),
              [
                "Email:gjøvik@avdeling.example",
                "Email:besoker@innsender.example",
                "SlackPost:DepartmentChannel",
                "SlackPost:Notifications",
              ]
            );
            const departmentSlack = messages.at(2);
            assert.isTrue(
              Predicate.isTagged(departmentSlack, "SlackPost") &&
                Predicate.isTagged(
                  departmentSlack.target,
                  "DepartmentChannel"
                ) &&
                departmentSlack.target.channel === "#avdeling-gjovik"
            );
          })
      );

      it.effect("RULE-249: an inactive department gets nothing enqueued", () =>
        Effect.gen(function* effectProgram() {
          const department = yield* (yield* DepartmentRepository).create(
            departmentDraft("Narvik", { active: false })
          );

          const db = yield* Drizzle;
          const before = (yield* db.select().from(schema.outbox)).length;

          const refused = yield* Effect.flip(
            transactional(
              ContactEndpoints.submitContact({
                departmentId: department.id,
                email: "besoker@innsender.example",
                message: "Hei",
                name: "Testperson",
                subject: "Spørsmål",
              }).pipe(asVisitor)
            )
          );

          assert.strictEqual(refused._tag, "ValidationFailed");
          assert.strictEqual(
            (yield* db.select().from(schema.outbox)).length,
            before
          );
        })
      );
    });
  }
);
