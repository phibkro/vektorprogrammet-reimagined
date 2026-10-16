/**
 * Domain commands from `@vektorprogrammet/domain` against `DatabaseLive` and
 * `transactional` on real PostgreSQL, asserting the persisted rows, audit
 * entries and outbox rows.
 */
import { assert, layer } from "@effect/vitest";
import {
  CurrentActor,
  DepartmentRepository,
  OutboxMessage,
  createSemester,
  ensureCurrentSemester,
  submitContact,
  updateStaticContent,
} from "@vektorprogrammet/domain";
import type { Actor } from "@vektorprogrammet/domain";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  Array as Arr,
  DateTime,
  Effect,
  Exit,
  Option,
  Predicate,
  Schema,
  pipe,
} from "effect";
import { TestClock } from "effect/testing";

import { schema, transactional } from "../src/index.ts";
import { Drizzle, postgresDatabase } from "./support/database.ts";
import {
  AT,
  departmentDraft,
  slackChannel,
  staff,
} from "./support/fixtures.ts";

const admin = staff({ role: "admin" });

const boardMember = staff({ executiveBoard: true, role: "teamMember" });

const teamLeader = staff({ executiveBoard: false, role: "teamLeader" });

const as =
  (actor: Actor) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.provideService(self, CurrentActor, actor);

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

layer(postgresDatabase(), { excludeTestServices: true })(
  "domain commands on PostgreSQL",
  (outerTest) => {
    outerTest.layer(TestClock.layer())((it) => {
      it.effect(
        "RULE-144: createSemester persists one row and one audit entry; a duplicate is refused and saves nothing",
        () =>
          Effect.gen(function* effectProgram() {
            yield* TestClock.setTime(DateTime.toEpochMillis(AT));

            const created = yield* transactional(
              createSemester({ term: "HOST", year: 2026 })
            ).pipe(as(admin));

            assert.deepStrictEqual(
              [created.term, created.year],
              ["HOST", 2026]
            );

            const duplicate = yield* Effect.flip(
              transactional(createSemester({ term: "HOST", year: 2026 })).pipe(
                as(admin)
              )
            );

            assert.strictEqual(duplicate._tag, "AlreadyExists");

            if (Predicate.isTagged(duplicate, "AlreadyExists")) {
              assert.strictEqual(
                duplicate.message,
                "Semesteret Høst 2026 finnes allerede"
              );
            }

            const db = yield* Drizzle;

            const rows = yield* db
              .select()
              .from(schema.semester)
              .where(
                and(
                  eq(schema.semester.term, "HOST"),
                  eq(schema.semester.year, 2026)
                )
              );

            assert.strictEqual(rows.length, 1);
            const audits = yield* auditRows("Semester", String(created.id));
            assert.strictEqual(audits.length, 1);
            assert.strictEqual(audits[0]?.action, "semester.created");
            assert.strictEqual(audits[0]?.actorId, admin.userId);
            assert.strictEqual(
              audits[0]?.at.toISOString(),
              "2026-10-15T10:00:00.000Z"
            );
          })
      );

      it.effect(
        "RULE-144: 20 concurrent createSemester commands commit exactly one row and one audit entry",
        () =>
          Effect.gen(function* effectProgram() {
            yield* TestClock.setTime(DateTime.toEpochMillis(AT));

            const exits = yield* Effect.all(
              Arr.makeBy(20, () =>
                Effect.exit(
                  transactional(
                    createSemester({ term: "VAR", year: 2027 })
                  ).pipe(as(admin))
                )
              ),
              { concurrency: "unbounded" }
            );

            const successes = pipe(exits, Arr.filter(Exit.isSuccess));
            assert.strictEqual(successes.length, 1);
            assert.isTrue(
              pipe(
                exits,
                Arr.filter(Exit.isFailure),
                Arr.every((exit) =>
                  Option.exists(
                    Exit.findErrorOption(exit),
                    Predicate.isTagged("AlreadyExists")
                  )
                )
              )
            );

            const [winner] = successes;

            if (winner === undefined) {
              assert.fail("expected one success");
            }

            assert.strictEqual(
              (yield* auditRows("Semester", String(winner.value.id))).length,
              1
            );
          })
      );

      it.effect(
        "RULE-237: 20 concurrent ensureCurrentSemester calls on an empty table create exactly one row",
        () =>
          Effect.gen(function* effectProgram() {
            // 2028-03-01 in Oslo is Vår 2028 (RULE-033); no audit entry (not a staff write).
            yield* TestClock.setTime(
              DateTime.toEpochMillis(
                DateTime.makeUnsafe("2028-03-01T12:00:00Z")
              )
            );

            const db = yield* Drizzle;
            // The earlier tests of this suite created semesters: the race starts from an empty table.
            yield* db.delete(schema.semester);
            assert.strictEqual(yield* db.$count(schema.semester), 0);

            const results = yield* Effect.all(
              Arr.makeBy(20, () => ensureCurrentSemester),
              {
                concurrency: "unbounded",
              }
            );

            const rows = yield* db.select().from(schema.semester);

            assert.deepStrictEqual(
              pipe(
                rows,
                Arr.map((row) => [row.term, row.year])
              ),
              [["VAR", 2028]]
            );
            assert.isTrue(
              pipe(
                results,
                Arr.every((semester) => semester.id === rows[0]?.id)
              )
            );
            assert.strictEqual(
              (yield* auditRows("Semester", String(rows[0]?.id))).length,
              0
            );
          })
      );

      it.effect(
        "RULE-296: an admin or board member replaces the block (created if missing) with sanitized HTML and an audit entry",
        () =>
          Effect.gen(function* effectProgram() {
            yield* TestClock.setTime(DateTime.toEpochMillis(AT));
            const db = yield* Drizzle;

            const block = () =>
              db
                .select()
                .from(schema.staticContent)
                .where(eq(schema.staticContent.key, "about-intro"));

            const created = yield* transactional(
              updateStaticContent({
                editorId: "about-intro",
                html: `<p>Om oss</p><img src="x" onerror="alert(1)"><script>alert(2)</script>`,
              })
            ).pipe(as(admin));

            assert.strictEqual(created.html, `<p>Om oss</p><img src="x" />`);
            assert.deepStrictEqual(
              pipe(
                yield* block(),
                Arr.map((row) => row.html)
              ),
              [`<p>Om oss</p><img src="x" />`]
            );

            yield* transactional(
              updateStaticContent({
                editorId: "about-intro",
                html: "<p>Nytt</p>",
              })
            ).pipe(as(boardMember));
            assert.deepStrictEqual(
              pipe(
                yield* block(),
                Arr.map((row) => row.html)
              ),
              ["<p>Nytt</p>"]
            );
            assert.deepStrictEqual(
              pipe(
                yield* auditRows("StaticContent", "about-intro"),
                Arr.map((row) => [row.action, row.actorId])
              ),
              [
                ["staticContent.updated", admin.userId],
                ["staticContent.updated", boardMember.userId],
              ]
            );
          })
      );

      it.effect(
        "RULE-296: a team leader outside the board is refused and nothing is written; a missing editorId is invalid",
        () =>
          Effect.gen(function* effectProgram() {
            const refused = yield* Effect.flip(
              transactional(
                updateStaticContent({
                  editorId: "parents-intro",
                  html: "<p>x</p>",
                })
              ).pipe(as(teamLeader))
            );

            assert.strictEqual(refused._tag, "Forbidden");

            const invalid = yield* Effect.flip(
              transactional(updateStaticContent({ html: "<p>x</p>" })).pipe(
                as(admin)
              )
            );

            assert.strictEqual(invalid._tag, "ValidationFailed");
            const db = yield* Drizzle;
            assert.deepStrictEqual(
              yield* db
                .select()
                .from(schema.staticContent)
                .where(eq(schema.staticContent.key, "parents-intro")),
              []
            );
            assert.deepStrictEqual(
              yield* auditRows("StaticContent", "parents-intro"),
              []
            );
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
              submitContact({
                departmentId: department.id,
                email: "besoker@innsender.example",
                message: "Hei, når åpner opptaket?",
                name: "Testperson",
                subject: "Spørsmål",
              })
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
                Arr.map((message) =>
                  Predicate.isTagged(message, "Email")
                    ? `Email:${message.to}`
                    : `SlackPost:${message.target._tag}`
                )
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
              submitContact({
                departmentId: department.id,
                email: "besoker@innsender.example",
                message: "Hei",
                name: "Testperson",
                subject: "Spørsmål",
              })
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
