import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, DateTime, Effect, Match } from "effect";
import { TestClock } from "effect/testing";

import {
  Actor,
  ArticleId,
  FileKey,
  NEWS_PAGE_SIZE,
  Slug,
  articleSavedNotice,
  createArticle,
  getPublicArticle,
  isPubliclyVisible,
  loadFrontPageNews,
  loadNewsPage,
  paginate,
  sanitizeRichText,
  selectFrontPageNews,
  setArticlePublished,
  slugify,
  uniqueSlug,
} from "../../src/index.ts";
import type { Article, PublicFile } from "../../src/index.ts";
import {
  BERGEN,
  TRONDHEIM,
  assertNoRows,
  TestServices,
  admin,
  asActor,
  at,
  failureTag,
  seed,
  table,
  teamMemberBergen,
} from "../support/inMemory.ts";

const SMALL = FileKey.make(`${"a".repeat(64)}.png`);

const LARGE = FileKey.make(`${"b".repeat(64)}.jpg`);

const PDF = FileKey.make(`${"c".repeat(64)}.pdf`);

const registered = (
  key: FileKey,
  contentType: PublicFile["contentType"]
): PublicFile => ({
  contentType,
  key,
  legacyPath: null,
  name: key,
  size: 10,
  uploadedAt: at("2026-01-01T00:00:00Z"),
  uploadedBy: null,
});

const seedImages = Effect.all([
  seed.publicFile(registered(SMALL, "image/png")),
  seed.publicFile(registered(LARGE, "image/jpeg")),
  seed.publicFile(registered(PDF, "application/pdf")),
]);

const validInput = {
  body: "<p>Søk nå</p>",
  departmentIds: [],
  imageLargeKey: LARGE,
  imageSmallKey: SMALL,
  published: false,
  sticky: false,
  title: "Opptak åpner!",
};

const NOW = "2026-10-15T10:00:00Z";

const article = (id: number, fields: Partial<Article>): Article => ({
  authorId: null,
  body: sanitizeRichText("<p>tekst</p>"),
  createdAt: at(NOW),
  departmentIds: [],
  id: ArticleId.make(id),
  imageLargeKey: LARGE,
  imageSmallKey: SMALL,
  published: true,
  slug: Slug.make(`artikkel-${id}`),
  sticky: false,
  title: `Artikkel ${id}`,
  ...fields,
});

describe("C5 slugs", () => {
  it("RULE-096: the slug maps Norwegian letters and drops punctuation", () => {
    assert.strictEqual(slugify("Opptak åpner!"), "opptak-apner");
    assert.strictEqual(
      slugify("Ærlig talt, Øystein. Å så bra"),
      "aerlig-talt-oystein-a-sa-bra"
    );
    assert.strictEqual(slugify("  !!!  "), "artikkel");
  });

  it("RULE-096: a taken slug gets the first free numeric suffix", () => {
    assert.strictEqual(uniqueSlug("Opptak åpner!", []), "opptak-apner");
    assert.strictEqual(
      uniqueSlug("Opptak åpner!", ["opptak-apner"]),
      "opptak-apner-2"
    );
    assert.strictEqual(
      uniqueSlug("Opptak åpner!", ["opptak-apner", "opptak-apner-2"]),
      "opptak-apner-3"
    );
    assert.strictEqual(
      uniqueSlug("Opptak åpner!", ["opptak-apner", "opptak-apner-3"]),
      "opptak-apner-2"
    );
  });

  it.effect(
    "RULE-096: creating articles with the same title yields -2 and -3",
    () =>
      Effect.gen(function* effectProgram() {
        yield* seedImages;
        const slugs: string[] = [];

        for (let i = 0; i < 3; i += 1) {
          slugs.push(
            (yield* asActor(admin)(createArticle(validInput))).article.slug
          );
        }

        assert.deepStrictEqual(slugs, [
          "opptak-apner",
          "opptak-apner-2",
          "opptak-apner-3",
        ]);
      }).pipe(Effect.provide(TestServices))
  );
});

describe("C5 article editor", () => {
  it.effect(
    "RULE-182: an article with only the large image is rejected and nothing is saved",
    () =>
      Effect.gen(function* effectProgram() {
        yield* seedImages;
        const { imageSmallKey: _omitted, ...onlyLarge } = validInput;

        const error = yield* Effect.flip(
          asActor(admin)(createArticle(onlyLarge))
        );

        assert.strictEqual(error._tag, "ValidationFailed");
        assertNoRows([
          yield* table((db) => db.articles),
          yield* table((db) => db.audit),
        ]);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-182: an image key that is not a registered image is rejected",
    () =>
      Effect.gen(function* effectProgram() {
        yield* seedImages;

        const notAnImage = yield* Effect.flip(
          asActor(admin)(createArticle({ ...validInput, imageSmallKey: PDF }))
        );

        const unknown = yield* Effect.flip(
          asActor(admin)(
            createArticle({
              ...validInput,
              imageLargeKey: `${"d".repeat(64)}.png`,
            })
          )
        );

        assert.strictEqual(notAnImage._tag, "ValidationFailed");
        assert.strictEqual(unknown._tag, "ValidationFailed");
        assertNoRows([yield* table((db) => db.articles)]);
      }).pipe(Effect.provide(TestServices))
  );

  it.effect("RULE-182: with both images the article is saved and audited", () =>
    Effect.gen(function* effectProgram() {
      yield* TestClock.setTime(DateTime.toEpochMillis(at(NOW)));
      yield* seedImages;

      const { article: saved } = yield* asActor(teamMemberBergen)(
        createArticle({ ...validInput, body: '<p onclick="x()">Søk nå</p>' })
      );

      assert.strictEqual(saved.body, "<p>Søk nå</p>");
      assert.strictEqual(saved.authorId, teamMemberBergen.userId);
      assert.strictEqual(
        DateTime.formatIso(saved.createdAt),
        "2026-10-15T10:00:00.000Z"
      );
      assert.strictEqual((yield* table((db) => db.articles)).length, 1);
    }).pipe(Effect.provide(TestServices))
  );

  it.effect(
    "RULE-266: creating a draft audits 'draft' and says 'kladd'; publishing audits 'published'",
    () =>
      Effect.gen(function* effectProgram() {
        yield* seedImages;

        const draft = yield* asActor(admin)(
          createArticle({ ...validInput, published: false })
        );

        const published = yield* asActor(admin)(
          createArticle({ ...validInput, published: true })
        );

        assert.strictEqual(draft.notice, "Artikkelen er lagret som kladd.");
        assert.strictEqual(published.notice, "Artikkelen har blitt publisert.");
        yield* asActor(admin)(setArticlePublished(draft.article.id, true));
        const audit = yield* table((db) => db.audit);
        assert.deepStrictEqual(
          Arr.map(audit, (e) => e.action),
          [
            "article.createdDraft",
            "article.createdPublished",
            "article.published",
          ]
        );
        assert.strictEqual(
          articleSavedNotice({ published: false }),
          "Artikkelen er lagret som kladd."
        );
      }).pipe(Effect.provide(TestServices))
  );

  it.effect("anonymous visitors cannot create articles", () =>
    Effect.gen(function* effectProgram() {
      yield* seedImages;

      const exit = yield* Effect.exit(
        asActor(Actor.cases.Anonymous.make({}))(createArticle(validInput))
      );

      assert.strictEqual(failureTag(exit), "Forbidden");
    }).pipe(Effect.provide(TestServices))
  );
});

describe("C5 public news", () => {
  it.effect(
    "RULE-267: a draft is 404 on the public site until it is published",
    () =>
      Effect.gen(function* effectProgram() {
        yield* seedImages;

        const { article: draft } = yield* asActor(admin)(
          createArticle(validInput)
        );

        assert.isFalse(isPubliclyVisible(draft));
        assert.strictEqual(
          failureTag(yield* Effect.exit(getPublicArticle(draft.slug))),
          "NotFound"
        );
        yield* asActor(admin)(setArticlePublished(draft.id, true));
        const shown = yield* getPublicArticle(draft.slug);
        assert.strictEqual(shown.id, draft.id);
        assert.strictEqual(
          failureTag(yield* Effect.exit(getPublicArticle("../etc/passwd"))),
          "NotFound"
        );
      }).pipe(Effect.provide(TestServices))
  );

  it("RULE-331: front page shows published news from the last 30 days or sticky", () => {
    const now = at(NOW);
    const fortyDaysAgo = DateTime.subtract(now, { days: 40 });
    const a = article(1, { createdAt: fortyDaysAgo, sticky: false });
    const b = article(2, { createdAt: fortyDaysAgo, sticky: true });

    const recent = article(3, {
      createdAt: DateTime.subtract(now, { days: 2 }),
    });

    const recentDraft = article(4, {
      createdAt: DateTime.subtract(now, { days: 1 }),
      published: false,
    });

    const stickyDraft = article(5, {
      createdAt: fortyDaysAgo,
      published: false,
      sticky: true,
    });

    const selected = selectFrontPageNews(
      [a, b, recent, recentDraft, stickyDraft],
      now
    );

    assert.deepStrictEqual(
      Arr.map(selected, (x) => x.id),
      [b.id, recent.id]
    );
  });

  it("RULE-331: sticky first, then newest first, and the limit applies", () => {
    const now = at(NOW);

    const older = article(1, {
      createdAt: DateTime.subtract(now, { days: 5 }),
    });

    const newer = article(2, {
      createdAt: DateTime.subtract(now, { days: 1 }),
    });

    const sticky = article(3, {
      createdAt: DateTime.subtract(now, { days: 90 }),
      sticky: true,
    });

    assert.deepStrictEqual(
      Arr.map(selectFrontPageNews([older, newer, sticky], now), (x) => x.id),
      [sticky.id, newer.id, older.id]
    );
    assert.deepStrictEqual(
      Arr.map(selectFrontPageNews([older, newer, sticky], now, 2), (x) => x.id),
      [sticky.id, newer.id]
    );
  });

  it.effect("RULE-331: the front-page query uses the Clock", () =>
    Effect.gen(function* effectProgram() {
      yield* TestClock.setTime(DateTime.toEpochMillis(at(NOW)));
      yield* seed.article(
        article(1, { createdAt: DateTime.subtract(at(NOW), { days: 29 }) })
      );
      yield* seed.article(
        article(2, { createdAt: DateTime.subtract(at(NOW), { days: 31 }) })
      );
      const news = yield* loadFrontPageNews();
      assert.deepStrictEqual(
        Arr.map(news, (x) => x.id),
        [ArticleId.make(1)]
      );
    }).pipe(Effect.provide(TestServices))
  );

  it("RULE-326: 35 published articles make 4 pages of 10, 10, 10 and 5", () => {
    const items = Array.from({ length: 35 }, (_, i) => i);

    const sizes = Arr.map(
      [1, 2, 3, 4],
      (page) => paginate(items, page).items.length
    );

    assert.deepStrictEqual(sizes, [10, 10, 10, 5]);
    assert.strictEqual(paginate(items, 1).totalPages, 4);
    assert.strictEqual(paginate(items, 5).items.length, 0);
    assert.strictEqual(NEWS_PAGE_SIZE, 10);
  });

  it.effect(
    "RULE-326: the news page lists published articles newest first, filtered by department",
    () =>
      Effect.gen(function* effectProgram() {
        const base = at(NOW);

        for (let i = 1; i <= 12; i += 1) {
          yield* seed.article(
            article(i, {
              createdAt: DateTime.subtract(base, { days: i }),
              departmentIds: Match.value(i % 3).pipe(
                Match.when(0, () => [BERGEN]),
                Match.when(1, () => [TRONDHEIM]),
                Match.orElse(() => [])
              ),
            })
          );
        }

        yield* seed.article(article(99, { published: false }));
        const first = yield* loadNewsPage({ page: 1 });
        assert.strictEqual(first.totalItems, 12);
        assert.deepStrictEqual(
          Arr.map(first.items, (x) => x.id),
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
        );
        const bergen = yield* loadNewsPage({ departmentId: BERGEN, page: 1 });
        // Tagged Bergen (3, 6, 9, 12) or untagged (2, 5, 8, 11).
        assert.deepStrictEqual(
          Arr.map(bergen.items, (x) => x.id),
          [2, 3, 5, 6, 8, 9, 11, 12]
        );
      }).pipe(Effect.provide(TestServices))
  );
});
