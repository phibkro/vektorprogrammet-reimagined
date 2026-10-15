/**
 * C4/C5/C6/C8 repositories: articles (RULE-096 unique slug), static content
 * (RULE-296 upsert), sponsors and social events.
 */
import {
  Article,
  ArticleRepository,
  NotFound,
  SocialEvent,
  SocialEventRepository,
  Sponsor,
  SponsorRepository,
  StaticContent,
  StaticContentRepository,
  slugify,
  uniqueSlug,
  type ArticleDraft,
  type ArticleId,
  type DepartmentId,
  type SanitizedHtml,
  type SemesterId,
  type Slug,
  type SocialEventDraft,
  type SponsorDraft,
  type StaticContentKey,
} from "@vektorprogrammet/domain";
import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { Array as Arr, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { classifySqlFailure } from "../classifySqlFailure.ts";
import { Drizzle, decodeWith, single } from "../internal/drizzle.ts";
import { article, articleDepartment, socialEvent, sponsor, staticContent } from "../schema.ts";

/** An article row as stored: `createdAt` is a `Date` from the driver. */
const ArticleRow = Schema.Struct({ ...Article.fields, createdAt: Schema.DateTimeUtcFromDate });

const articleColumns = {
  id: article.id,
  title: article.title,
  slug: article.slug,
  body: article.body,
  imageSmallKey: article.imageSmallKey,
  imageLargeKey: article.imageLargeKey,
  sticky: article.sticky,
  published: article.published,
  authorId: article.authorId,
  createdAt: article.createdAt,
};

export const ArticleRepositoryLive = Layer.effect(
  ArticleRepository,
  Effect.gen(function* () {
    const db = yield* Drizzle;
    const sqlClient = yield* SqlClient;
    const decodeAll = decodeWith(Schema.Array(ArticleRow));

    interface StoredArticleRow {
      readonly id: number;
      readonly [column: string]: unknown;
    }

    /** Attaches the department tags (one query for all rows) and decodes. */
    const withDepartments = Effect.fnUntraced(function* (rows: ReadonlyArray<StoredArticleRow>) {
      if (rows.length === 0) return [];
      const tags = yield* db
        .select()
        .from(articleDepartment)
        .where(
          inArray(
            articleDepartment.articleId,
            rows.map((row) => row.id),
          ),
        )
        .orderBy(asc(articleDepartment.departmentId))
        .pipe(Effect.orDie);
      return yield* decodeAll(
        rows.map((row) => ({
          ...row,
          departmentIds: tags
            .filter((tag) => tag.articleId === row.id)
            .map((tag) => tag.departmentId),
        })),
      );
    });

    const one = (rows: ReadonlyArray<StoredArticleRow>) =>
      Effect.flatMap(withDepartments(rows), single);

    const slugsLike = Effect.fn("ArticleRepository.slugsLike")(function* (base: Slug) {
      const rows = yield* db
        .select({ slug: article.slug })
        .from(article)
        .where(or(eq(article.slug, base), like(article.slug, `${base}-%`)))
        .pipe(Effect.orDie);
      // `Slug` admits only [a-z0-9-], so `base` holds no LIKE wildcard; stored slugs pass the same check.
      return yield* decodeWith(Schema.Array(Article.fields.slug))(rows.map((row) => row.slug));
    });

    /**
     * One savepoint per attempt: a unique violation inside the caller's
     * transaction then rolls back only this attempt, not the whole command.
     */
    const insertOnce = (draft: ArticleDraft, slug: Slug) =>
      sqlClient
        .withTransaction(
          Effect.gen(function* () {
            const row = yield* db
              .insert(article)
              .values({
                title: draft.title,
                slug,
                body: draft.body,
                imageSmallKey: draft.imageSmallKey,
                imageLargeKey: draft.imageLargeKey,
                sticky: draft.sticky,
                published: draft.published,
                authorId: draft.authorId,
                createdAt: DateTime.toDateUtc(draft.createdAt),
              })
              .returning(articleColumns)
              .pipe(Effect.flatMap(single));
            const departmentIds = Arr.dedupe(draft.departmentIds);
            if (Arr.isReadonlyArrayNonEmpty(departmentIds)) {
              yield* db
                .insert(articleDepartment)
                .values(departmentIds.map((departmentId) => ({ articleId: row.id, departmentId })));
            }
            return row;
          }),
        )
        .pipe(Effect.catch((failure) => classifySqlFailure(failure, slug)));

    /**
     * RULE-096 race: the domain picked a free slug, but a concurrent create may
     * take it first. The unique constraint refuses the second insert; one retry
     * re-reads the taken slugs and picks the next suffix. A second collision
     * surfaces as `AlreadyExists`.
     */
    const create = Effect.fn("ArticleRepository.create")(function* (draft: ArticleDraft) {
      const row = yield* insertOnce(draft, draft.slug).pipe(
        Effect.catchTag("AlreadyExists", () =>
          Effect.flatMap(slugsLike(slugify(draft.title)), (taken) =>
            insertOnce(draft, uniqueSlug(draft.title, taken)),
          ),
        ),
      );
      return yield* one([row]);
    });

    const findById = Effect.fn("ArticleRepository.findById")(function* (id: ArticleId) {
      const rows = yield* db
        .select(articleColumns)
        .from(article)
        .where(eq(article.id, id))
        .pipe(Effect.orDie);
      if (rows.length === 0) return yield* new NotFound({ entity: "Article", key: String(id) });
      return yield* one(rows);
    });

    const findBySlug = Effect.fn("ArticleRepository.findBySlug")(function* (slug: Slug) {
      const rows = yield* db
        .select(articleColumns)
        .from(article)
        .where(eq(article.slug, slug))
        .pipe(Effect.orDie);
      return rows.length === 0 ? Option.none() : Option.some(yield* one(rows));
    });

    const setPublished = Effect.fn("ArticleRepository.setPublished")(function* (
      id: ArticleId,
      published: boolean,
    ) {
      const rows = yield* db
        .update(article)
        .set({ published })
        .where(eq(article.id, id))
        .returning(articleColumns)
        .pipe(Effect.orDie);
      if (rows.length === 0) return yield* new NotFound({ entity: "Article", key: String(id) });
      return yield* one(rows);
    });

    return ArticleRepository.of({
      create,
      findById,
      findBySlug,
      slugsLike,
      listPublished: db
        .select(articleColumns)
        .from(article)
        .where(eq(article.published, true))
        .pipe(
          Effect.orDie,
          Effect.flatMap(withDepartments),
          Effect.withSpan("ArticleRepository.listPublished"),
        ),
      setPublished,
    });
  }),
);

const staticContentColumns = { key: staticContent.key, html: staticContent.html };

export const StaticContentRepositoryLive = Layer.effect(
  StaticContentRepository,
  Effect.gen(function* () {
    const db = yield* Drizzle;
    const decode = decodeWith(StaticContent);

    const find = Effect.fn("StaticContentRepository.find")(function* (key: StaticContentKey) {
      const rows = yield* db
        .select(staticContentColumns)
        .from(staticContent)
        .where(eq(staticContent.key, key))
        .pipe(Effect.orDie);
      const row = rows[0];
      return row === undefined ? Option.none() : Option.some(yield* decode(row));
    });

    /** RULE-296: replaces the block, creating it when missing, in one statement. */
    const upsert = Effect.fn("StaticContentRepository.upsert")(function* (
      key: StaticContentKey,
      html: SanitizedHtml,
    ) {
      const rows = yield* db
        .insert(staticContent)
        .values({ key, html })
        .onConflictDoUpdate({ target: staticContent.key, set: { html: sql`excluded.html` } })
        .returning(staticContentColumns)
        .pipe(Effect.orDie);
      return yield* decode(yield* single(rows));
    });

    return StaticContentRepository.of({ find, upsert });
  }),
);

const sponsorColumns = {
  id: sponsor.id,
  name: sponsor.name,
  url: sponsor.url,
  size: sponsor.size,
  logoKey: sponsor.logoKey,
};

export const SponsorRepositoryLive = Layer.effect(
  SponsorRepository,
  Effect.gen(function* () {
    const db = yield* Drizzle;
    const decode = decodeWith(Sponsor);
    const decodeAll = decodeWith(Schema.Array(Sponsor));

    const create = Effect.fn("SponsorRepository.create")(function* (draft: SponsorDraft) {
      const rows = yield* db
        .insert(sponsor)
        .values(draft)
        .returning(sponsorColumns)
        .pipe(Effect.orDie);
      return yield* decode(yield* single(rows));
    });

    return SponsorRepository.of({
      list: db
        .select(sponsorColumns)
        .from(sponsor)
        .pipe(Effect.orDie, Effect.flatMap(decodeAll), Effect.withSpan("SponsorRepository.list")),
      create,
    });
  }),
);

/** A social event row as stored: the window bounds are `Date`s from the driver. */
const SocialEventRow = Schema.Struct({
  ...SocialEvent.fields,
  startsAt: Schema.DateTimeUtcFromDate,
  endsAt: Schema.DateTimeUtcFromDate,
});

const socialEventColumns = {
  id: socialEvent.id,
  title: socialEvent.title,
  description: socialEvent.description,
  startsAt: socialEvent.startsAt,
  endsAt: socialEvent.endsAt,
  link: socialEvent.link,
  departmentId: socialEvent.departmentId,
  semesterId: socialEvent.semesterId,
};

export const SocialEventRepositoryLive = Layer.effect(
  SocialEventRepository,
  Effect.gen(function* () {
    const db = yield* Drizzle;
    const decode = decodeWith(SocialEventRow);
    const decodeAll = decodeWith(Schema.Array(SocialEventRow));

    const list = Effect.fn("SocialEventRepository.list")(function* (filter: {
      readonly departmentId: DepartmentId;
      readonly semesterId: SemesterId;
    }) {
      const rows = yield* db
        .select(socialEventColumns)
        .from(socialEvent)
        .where(
          and(
            eq(socialEvent.departmentId, filter.departmentId),
            eq(socialEvent.semesterId, filter.semesterId),
          ),
        )
        .pipe(Effect.orDie);
      return yield* decodeAll(rows);
    });

    const create = Effect.fn("SocialEventRepository.create")(function* (draft: SocialEventDraft) {
      const rows = yield* db
        .insert(socialEvent)
        .values({
          ...draft,
          startsAt: DateTime.toDateUtc(draft.startsAt),
          endsAt: DateTime.toDateUtc(draft.endsAt),
        })
        .returning(socialEventColumns)
        .pipe(Effect.orDie);
      return yield* decode(yield* single(rows));
    });

    return SocialEventRepository.of({ list, create });
  }),
);
