/**
 * Fast repository tests: the production `RepositoriesLayer` and the generated
 * migrations on an in-memory PGlite (Drizzle `effect-pglite` + `@effect/sql-pglite`).
 * Concurrency, Hyperdrive-relevant and driver-codec behaviour is covered on
 * real PostgreSQL in `*.postgres.test.ts`.
 */
import { assert, layer } from "@effect/vitest";
import {
  ArticleRepository,
  AuditLog,
  ArticleId,
  DepartmentId,
  FieldOfStudyId,
  DepartmentRepository,
  FieldOfStudyRepository,
  Outbox,
  OutboxMessage,
  PublicFileRepository,
  SemesterId,
  SemesterRepository,
  SocialEventRepository,
  Slug,
  SlackTarget,
  SponsorRepository,
  StaticContentKey,
  StaticContentRepository,
  UserId,
  HttpUrl,
  sanitizeRichText,
} from "@vektorprogrammet/domain";
import type { ArticleDraft } from "@vektorprogrammet/domain";
import { eq } from "drizzle-orm";
import {
  Array as Arr,
  DateTime,
  Effect,
  Exit,
  Option,
  Order,
  Predicate,
  pipe,
} from "effect";

import { OutboxDelivery, schema } from "../src/index.ts";
import { Drizzle, pgliteDatabase } from "./support/database.ts";
import {
  AT,
  departmentDraft,
  fileKey,
  publicFileFixture,
  registerImages,
  slackChannel,
} from "./support/fixtures.ts";

const articleDraft = (overrides: Partial<ArticleDraft> = {}): ArticleDraft => ({
  authorId: UserId.make(42),
  body: sanitizeRichText("<p>Velkommen</p>"),
  createdAt: AT,
  departmentIds: [],
  imageLargeKey: fileKey("b"),
  imageSmallKey: fileKey("a"),
  published: false,
  slug: Slug.make("opptak-apner"),
  sticky: false,
  title: "Opptak åpner!",
  ...overrides,
});

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
    "article: create with tags, find, slugsLike, publish; drafts are not listed",
    () =>
      Effect.gen(function* effectProgram() {
        yield* registerImages(fileKey("a"), fileKey("b"));

        const department = yield* (yield* DepartmentRepository).create(
          departmentDraft("Tromsø")
        );

        const articles = yield* ArticleRepository;

        const created = yield* articles.create(
          articleDraft({ departmentIds: [department.id, department.id] })
        );

        assert.strictEqual(created.slug, "opptak-apner");
        assert.deepStrictEqual(created.departmentIds, [department.id]);
        assert.isTrue(DateTime.Equivalence(created.createdAt, AT));
        assert.deepStrictEqual(yield* articles.findById(created.id), created);
        assert.deepStrictEqual(
          yield* articles.findBySlug(created.slug),
          Option.some(created)
        );
        assert.isFalse(
          pipe(
            yield* articles.listPublished,
            Arr.some((a) => a.id === created.id)
          )
        );
        const published = yield* articles.setPublished(created.id, true);
        assert.isTrue(published.published);
        assert.isTrue(
          pipe(
            yield* articles.listPublished,
            Arr.some((a) => a.id === created.id)
          )
        );
        assert.deepStrictEqual(
          Arr.map(yield* articles.slugsLike(Slug.make("opptak-apner")), String),
          ["opptak-apner"]
        );

        const missing = yield* Effect.flip(
          articles.setPublished(ArticleId.make(999_999), true)
        );

        assert.strictEqual(missing._tag, "NotFound");
      })
  );

  it.effect(
    "RULE-096: a slug taken after the domain chose it is retried once with the next suffix",
    () =>
      Effect.gen(function* effectProgram() {
        yield* registerImages(fileKey("a"), fileKey("b"));
        const articles = yield* ArticleRepository;

        const draft = articleDraft({
          slug: Slug.make("sommerfest"),
          title: "Sommerfest",
        });

        const first = yield* articles.create(draft);
        // Simulates the race: the second create still carries the slug the first one took.
        const second = yield* articles.create(draft);
        assert.strictEqual(first.slug, "sommerfest");
        assert.strictEqual(second.slug, "sommerfest-2");
        const third = yield* articles.create(draft);
        assert.strictEqual(third.slug, "sommerfest-3");
        assert.deepStrictEqual(
          pipe(
            [...(yield* articles.slugsLike(Slug.make("sommerfest")))],
            Arr.sortBy<readonly string[]>(Order.String)
          ),
          ["sommerfest", "sommerfest-2", "sommerfest-3"]
        );
      })
  );

  it.effect("RULE-133: stored rich text is sanitized again when read", () =>
    Effect.gen(function* effectProgram() {
      const db = yield* Drizzle;
      yield* db.insert(schema.staticContent).values({
        html: `<p>Hei</p><script>alert("x")</script>`,
        key: "legacy-block",
      });

      const block = yield* (yield* StaticContentRepository).find(
        StaticContentKey.make("legacy-block")
      );

      assert.deepStrictEqual(
        Option.map(block, (b) => b.html),
        Option.some("<p>Hei</p>")
      );
    })
  );

  it.effect(
    "RULE-296: static content upsert creates the block, then replaces its HTML",
    () =>
      Effect.gen(function* effectProgram() {
        const blocks = yield* StaticContentRepository;
        const key = StaticContentKey.make("about-intro");
        assert.isTrue(Option.isNone(yield* blocks.find(key)));
        yield* blocks.upsert(key, sanitizeRichText("<p>Første</p>"));

        const replaced = yield* blocks.upsert(
          key,
          sanitizeRichText("<p>Andre</p>")
        );

        assert.strictEqual(replaced.html, "<p>Andre</p>");
        assert.deepStrictEqual(yield* blocks.find(key), Option.some(replaced));
      })
  );

  it.effect(
    "RULE-189: sponsor create and list (logo is a registered file)",
    () =>
      Effect.gen(function* effectProgram() {
        yield* registerImages(fileKey("c"));
        const sponsors = yield* SponsorRepository;

        const created = yield* sponsors.create({
          logoKey: fileKey("c"),
          name: "Eksempel AS",
          size: "large",
          url: HttpUrl.make("https://sponsor.example"),
        });

        assert.isTrue(
          pipe(
            yield* sponsors.list,
            Arr.some((s) => s.id === created.id && s.size === "large")
          )
        );

        const unregistered = yield* Effect.exit(
          sponsors.create({
            logoKey: fileKey("d"),
            name: "Uten logo",
            size: "small",
            url: HttpUrl.make("https://sponsor.example"),
          })
        );

        assert.isTrue(Exit.hasDies(unregistered));
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

        const claimed = yield* delivery.claimDue({
          ids,
          leaseSeconds: 60,
          limit: 10,
        });

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
          yield* delivery.claimDue({ ids, leaseSeconds: 60, limit: 10 }),
          []
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
            "dead"
          ),
          "recorded"
        );
        assert.deepStrictEqual(
          yield* delivery.claimDue({ ids, leaseSeconds: 60, limit: 10 }),
          []
        );
      })
  );

  it.effect("audit log: record writes one row", () =>
    Effect.gen(function* effectProgram() {
      const audit = yield* AuditLog;
      yield* audit.record({
        action: "sponsor.created",
        actorId: UserId.make(7),
        at: AT,
        entity: "Sponsor",
        entityKey: "77",
      });
      const db = yield* Drizzle;

      const rows = yield* db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entityKey, "77"));

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.action, "sponsor.created");
      assert.strictEqual(rows[0]?.at.toISOString(), "2026-10-15T10:00:00.000Z");
    })
  );
});
