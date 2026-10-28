/**
 * Fast repository tests: the production `RepositoriesLayer` and the generated
 * migrations on an in-memory PGlite (Drizzle `effect-pglite` + `@effect/sql-pglite`).
 * Concurrency, Hyperdrive-relevant and driver-codec behaviour is covered on
 * real PostgreSQL in `*.postgres.test.ts`.
 */
import { assert, layer } from "@effect/vitest";
import {
  AdmissionPeriodRepository,
  AuditLog,
  DepartmentId,
  FieldOfStudyId,
  DepartmentRepository,
  FieldOfStudyRepository,
  Outbox,
  OutboxDelivery,
  OutboxMessage,
  PublicFileRepository,
  SemesterId,
  SemesterRepository,
  SocialEventRepository,
  SlackTarget,
  AuditPrincipal,
  PersonId,
  hasOpenAdmission,
} from "@vektorprogrammet/domain";
import { eq } from "drizzle-orm";
import {
  Array as Arr,
  DateTime,
  Effect,
  Exit,
  Option,
  Predicate,
  pipe,
} from "effect";

import { schema } from "../src/index.ts";
import { Drizzle, pgliteDatabase } from "./support/database.ts";
import {
  AT,
  departmentDraft,
  fileKey,
  publicFileFixture,
  slackChannel,
} from "./support/fixtures.ts";

layer(pgliteDatabase)("repositories on PGlite", (it) => {
  it.effect(
    "department: create, find, update, list; unique city is AlreadyExists",
    () =>
      Effect.gen(function* effectProgram() {
        const departments = yield* DepartmentRepository;

        const created = yield* departments.create(
          departmentDraft("Trondheim", {
            slackChannel: slackChannel("avdeling-trondheim"),
          })
        );

        assert.strictEqual(created.city, "Trondheim");
        assert.strictEqual(created.slackChannel, "#avdeling-trondheim");
        assert.deepStrictEqual(
          yield* departments.findById(created.id),
          created
        );

        const duplicate = yield* Effect.flip(
          departments.create(departmentDraft("Trondheim"))
        );

        assert.strictEqual(duplicate._tag, "AlreadyExists");
        assert.strictEqual(duplicate.entity, "Department");
        assert.strictEqual(duplicate.key, "Trondheim");

        const updated = yield* departments.update(
          created.id,
          departmentDraft("Trondheim", {
            latitude: 63.4195,
            longitude: 10.4023,
            name: "Vektor NTNU",
          })
        );

        assert.strictEqual(updated.name, "Vektor NTNU");
        assert.strictEqual(updated.latitude, 63.4195);

        const missing = yield* Effect.flip(
          departments.findById(DepartmentId.make(999_999))
        );

        assert.strictEqual(missing._tag, "NotFound");

        const missingUpdate = yield* Effect.flip(
          departments.update(
            DepartmentId.make(999_999),
            departmentDraft("Ingensteds")
          )
        );

        assert.strictEqual(missingUpdate._tag, "NotFound");

        const other = yield* departments.create(departmentDraft("Bergen"));

        const clash = yield* Effect.flip(
          departments.update(other.id, departmentDraft("Trondheim"))
        );

        assert.strictEqual(clash._tag, "AlreadyExists");
        assert.isTrue(
          pipe(
            yield* departments.list,
            Arr.some((row) => row.id === other.id)
          )
        );
      })
  );

  it.effect(
    "RULE-237: semester find answers the stored row or none, and never inserts",
    () =>
      Effect.gen(function* effectProgram() {
        const semesters = yield* SemesterRepository;

        assert.isTrue(
          Option.isNone(yield* semesters.find({ term: "HOST", year: 2030 }))
        );

        const first = yield* semesters.ensure({ term: "HOST", year: 2030 });

        assert.deepStrictEqual(
          yield* semesters.find({ term: "HOST", year: 2030 }),
          Option.some(first)
        );
        assert.isTrue(
          Option.isNone(yield* semesters.find({ term: "VAR", year: 2030 }))
        );
        assert.deepStrictEqual(
          Arr.filter(yield* semesters.list, (s) => s.year === 2030),
          [first]
        );
      })
  );

  it.effect(
    "RULE-237: semester ensure creates once and returns the same row afterwards",
    () =>
      Effect.gen(function* effectProgram() {
        const semesters = yield* SemesterRepository;
        const created = yield* semesters.ensure({ term: "VAR", year: 2031 });
        const again = yield* semesters.ensure({ term: "VAR", year: 2031 });
        assert.deepStrictEqual(again, created);

        const rows = Arr.filter(
          yield* semesters.list,
          (s) => s.term === "VAR" && s.year === 2031
        );

        assert.strictEqual(rows.length, 1);
      })
  );

  it.effect(
    "field of study: create, list by department, rename, NotFound",
    () =>
      Effect.gen(function* effectProgram() {
        const department = yield* (yield* DepartmentRepository).create(
          departmentDraft("Ås")
        );

        const fields = yield* FieldOfStudyRepository;

        const created = yield* fields.create({
          departmentId: department.id,
          name: "Lektorutdanning",
          shortName: "LUR",
        });

        assert.deepStrictEqual(yield* fields.listByDepartment(department.id), [
          created,
        ]);

        const renamed = yield* fields.rename(created.id, {
          name: "Matematikk",
          shortName: "MAT",
        });

        assert.strictEqual(renamed.name, "Matematikk");
        assert.deepStrictEqual(yield* fields.findById(created.id), renamed);

        const missing = yield* Effect.flip(
          fields.rename(FieldOfStudyId.make(999_999), renamed)
        );

        assert.strictEqual(missing._tag, "NotFound");
      })
  );

  it.effect(
    "RULE-188: social events list by department and semester; end before start is refused",
    () =>
      Effect.gen(function* effectProgram() {
        const department = yield* (yield* DepartmentRepository).create(
          departmentDraft("Oslo")
        );

        const semester = yield* (yield* SemesterRepository).ensure({
          term: "HOST",
          year: 2026,
        });

        const events = yield* SocialEventRepository;
        const startsAt = DateTime.makeUnsafe("2026-10-20T16:00:00.000Z");
        const endsAt = DateTime.makeUnsafe("2026-10-20T20:00:00.000Z");

        const created = yield* events.create({
          departmentId: department.id,
          description: "",
          endsAt,
          link: null,
          semesterId: semester.id,
          startsAt,
          title: "Sosialkveld",
        });

        assert.isTrue(DateTime.Equivalence(created.startsAt, startsAt));
        assert.deepStrictEqual(
          yield* events.list({
            departmentId: department.id,
            semesterId: semester.id,
          }),
          [created]
        );
        assert.deepStrictEqual(
          yield* events.list({
            departmentId: department.id,
            semesterId: SemesterId.make(999_999),
          }),
          []
        );

        const backwards = yield* Effect.exit(
          events.create({
            departmentId: department.id,
            description: "",
            endsAt: startsAt,
            link: null,
            semesterId: semester.id,
            startsAt: endsAt,
            title: "Baklengs",
          })
        );

        assert.isTrue(Exit.hasDies(backwards));
      })
  );

  it.effect(
    "RULE-119: admission periods are read with their semester, and hasOpenAdmission answers over them",
    () =>
      Effect.gen(function* effectProgram() {
        const db = yield* Drizzle;

        const department = yield* (yield* DepartmentRepository).create(
          departmentDraft("Kristiansand")
        );

        const semester = yield* (yield* SemesterRepository).ensure({
          term: "HOST",
          year: 2026,
        });

        yield* db
          .insert(schema.admissionPeriod)
          .values({
            departmentId: department.id,
            endsAt: DateTime.toDateUtc(
              DateTime.makeUnsafe("2026-09-01T00:00:00.000Z")
            ),
            semesterId: semester.id,
            startsAt: DateTime.toDateUtc(
              DateTime.makeUnsafe("2026-08-01T00:00:00.000Z")
            ),
          })
          .pipe(Effect.orDie);

        const periods = yield* (yield* AdmissionPeriodRepository).list;

        assert.deepStrictEqual(
          Arr.map(periods, (period) => [
            period.departmentId,
            period.semester.term,
            period.semester.year,
            DateTime.formatIso(period.start),
            DateTime.formatIso(period.end),
          ]),
          [
            [
              department.id,
              "HOST",
              2026,
              "2026-08-01T00:00:00.000Z",
              "2026-09-01T00:00:00.000Z",
            ],
          ]
        );
        assert.isTrue(
          hasOpenAdmission(
            periods,
            DateTime.makeUnsafe("2026-08-15T12:00:00.000Z")
          )
        );
        assert.isFalse(
          hasOpenAdmission(
            periods,
            DateTime.makeUnsafe("2026-09-01T00:00:00.000Z")
          )
        );
      })
  );

  it.effect(
    "RULE-290: public files resolve only when registered and not deleted; register is idempotent",
    () =>
      Effect.gen(function* effectProgram() {
        const files = yield* PublicFileRepository;
        const key = fileKey("e", "pdf");

        const stored = yield* files.register(
          publicFileFixture(key, {
            contentType: "application/pdf",
            legacyPath: "Offentlige filer/vedtekter.pdf",
            name: "vedtekter.pdf",
          })
        );

        const again = yield* files.register(
          publicFileFixture(key, { name: "annet-navn.pdf" })
        );

        assert.deepStrictEqual(again, stored);
        assert.deepStrictEqual(
          yield* files.findByKey(key),
          Option.some(stored)
        );
        assert.deepStrictEqual(
          yield* files.findByLegacyPath("Offentlige filer/vedtekter.pdf"),
          Option.some(stored)
        );
        assert.isTrue(
          Option.isNone(yield* files.findByKey(fileKey("f", "pdf")))
        );

        const db = yield* Drizzle;
        yield* db
          .update(schema.publicFile)
          .set({
            deletedAt: DateTime.toDate(
              DateTime.makeUnsafe("2026-10-16T00:00:00.000Z")
            ),
          })
          .where(eq(schema.publicFile.key, key));
        assert.isTrue(Option.isNone(yield* files.findByKey(key)));
        assert.isTrue(
          Option.isNone(
            yield* files.findByLegacyPath("Offentlige filer/vedtekter.pdf")
          )
        );
      })
  );

  it.effect(
    "outbox: enqueue keeps order; claim, deliver and dead-letter are fenced by the claim token",
    () =>
      Effect.gen(function* effectProgram() {
        const outbox = yield* Outbox;
        const delivery = yield* OutboxDelivery;

        const ids = yield* outbox.enqueue([
          OutboxMessage.cases.SlackPost.make({
            target: SlackTarget.cases.Notifications.make({}),
            text: "første",
          }),
          OutboxMessage.cases.SlackPost.make({
            target: SlackTarget.cases.Notifications.make({}),
            text: "andre",
          }),
        ]);

        const claimAll = Effect.forEach(ids, (id) => delivery.claim(id, 60));

        /** What a second claim of each row finds: the tags only. */
        const claimTags = Effect.map(claimAll, (found) =>
          Arr.map(found, (claim) => claim._tag)
        );

        const claims = yield* claimAll;

        const claimed = Arr.flatMap(claims, (claim) =>
          Predicate.isTagged(claim, "Claimed") ? [claim.row] : []
        );

        assert.deepStrictEqual(
          Arr.map(claimed, (row) => row.id),
          [...ids]
        );
        assert.deepStrictEqual(
          pipe(
            claimed,
            Arr.map((row) =>
              Predicate.isTagged(row.message, "SlackPost")
                ? row.message.text
                : false
            )
          ),
          ["første", "andre"]
        );
        assert.deepStrictEqual(
          yield* claimTags,
          ["Held", "Held"],
          "a live claim holds each row"
        );
        const [first, second] = claimed;

        if (first === undefined || second === undefined) {
          assert.fail("expected two claims");
        }

        assert.strictEqual(
          yield* delivery.markDelivered(first.id, second.claimToken),
          "claimLost"
        );
        assert.strictEqual(
          yield* delivery.markDelivered(first.id, first.claimToken),
          "recorded"
        );
        assert.strictEqual(
          yield* delivery.markDelivered(first.id, first.claimToken),
          "claimLost"
        );
        assert.strictEqual(
          yield* delivery.markFailed(
            second.id,
            second.claimToken,
            "smtp 451",
            DateTime.add(AT, { minutes: 5 })
          ),
          "recorded"
        );
        assert.strictEqual(yield* delivery.markDead(second.id), "failed");
        assert.deepStrictEqual(
          yield* claimTags,
          ["Settled", "Settled"],
          "a delivered row and a dead row are both settled"
        );
      })
  );

  it.effect(
    "audit log: record writes one row for a person and one for a job, and latest reads them back",
    () =>
      Effect.gen(function* effectProgram() {
        const audit = yield* AuditLog;
        yield* audit.record({
          action: "department.created",
          at: AT,
          client: "browser",
          entity: "Department",
          entityKey: "77",
          principal: AuditPrincipal.cases.Person.make({
            personId: PersonId.make(7),
          }),
          sessionId: "test-session",
        });
        yield* audit.record({
          action: "endingSoon.sent",
          at: AT,
          client: "scheduler",
          entity: "Person",
          entityKey: "8",
          principal: AuditPrincipal.cases.System.make({ job: "endingSoon" }),
          sessionId: null,
        });
        const db = yield* Drizzle;

        const rows = yield* db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.entityKey, "77"));

        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0]?.action, "department.created");
        assert.strictEqual(rows[0]?.personId, 7);
        assert.strictEqual(rows[0]?.systemJob, null);
        assert.strictEqual(rows[0]?.client, "browser");
        assert.strictEqual(rows[0]?.sessionId, "test-session");
        assert.strictEqual(
          rows[0]?.at.toISOString(),
          "2026-10-15T10:00:00.000Z"
        );

        const latest = yield* audit.latest(2);

        assert.deepStrictEqual(
          Arr.map(latest, (entry) => entry.principal),
          [
            AuditPrincipal.cases.System.make({ job: "endingSoon" }),
            AuditPrincipal.cases.Person.make({ personId: PersonId.make(7) }),
          ]
        );
      })
  );
});
