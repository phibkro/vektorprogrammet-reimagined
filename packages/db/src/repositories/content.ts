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
} from "@vektorprogrammet/domain";
import type {
  ArticleDraft,
  ArticleId,
  DepartmentId,
  SanitizedHtml,
  SemesterId,
  Slug,
  SocialEventDraft,
  SponsorDraft,
  StaticContentKey,
} from "@vektorprogrammet/domain";
import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import {
  Array as Arr,
  DateTime,
  Effect,
  Layer,
  Option,
  pipe,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { classifySqlFailure } from "../classifySqlFailure.ts";
import {
  Drizzle,
  decodeFirstOption,
  decodeWith,
  single,
} from "../internal/drizzle.ts";
import {
  article,
  articleDepartment,
  socialEvent,
  sponsor,
  staticContent,
} from "../schema.ts";

/** An article row as stored: `createdAt` is a `Date` from the driver. */
const ArticleRow = Schema.Struct({
  ...Article.fields,
  createdAt: Schema.DateTimeUtcFromDate,
});

const articleColumns = {
  authorId: article.authorId,
  body: article.body,
  createdAt: article.createdAt,
  id: article.id,
  imageLargeKey: article.imageLargeKey,
  imageSmallKey: article.imageSmallKey,
  published: article.published,
  slug: article.slug,
  sticky: article.sticky,
  title: article.title,
};

export const ArticleRepositoryLive = Layer.effect(
  ArticleRepository,
  Effect.gen(function* ArticleRepositoryLive() {
    const db = yield* Drizzle;
    const sqlClient = yield* SqlClient;
    const decodeAll = decodeWith(Schema.Array(ArticleRow));

    type StoredArticleRow = typeof article.$inferSelect;

    /** Attaches the department tags (one query for all rows) and decodes. */
    const withDepartments = Effect.fnUntraced(function* withDepartments(
      rows: readonly StoredArticleRow[]
    ) {
      if (rows.length === 0) {
        return [];
      }

      const tags = yield* db
        .select()
        .from(articleDepartment)
        .where(
          inArray(
            articleDepartment.articleId,
            pipe(
              rows,
              Arr.map((row) => row.id)
            )
          )
        )
        .orderBy(asc(articleDepartment.departmentId))
        .pipe(Effect.orDie);

      return yield* decodeAll(
        pipe(
          rows,
          Arr.map((row) => ({
            ...row,
            departmentIds: pipe(
              tags,
              Arr.filter((tag) => tag.articleId === row.id),
              Arr.map((tag) => tag.departmentId)
            ),
          }))
        )
      );
    });

    const one = (rows: readonly StoredArticleRow[]) =>
      Effect.flatMap(withDepartments(rows), single);

    const oneById = (id: ArticleId, rows: readonly StoredArticleRow[]) =>
      Effect.gen(function* findOneById() {
        if (rows.length === 0) {
          return yield* new NotFound({ entity: "Article", key: String(id) });
        }

        return yield* one(rows);
      });

    const slugsLike = Effect.fn("ArticleRepository.slugsLike")(
      function* slugsLike(base: Slug) {
        const rows = yield* db
          .select({ slug: article.slug })
          .from(article)
          .where(or(eq(article.slug, base), like(article.slug, `${base}-%`)))
          .pipe(Effect.orDie);

        // `Slug` admits only [a-z0-9-], so `base` holds no LIKE wildcard; stored slugs pass the same check.
        return yield* decodeWith(Schema.Array(Article.fields.slug))(
          pipe(
            rows,
            Arr.map((row) => row.slug)
          )
        );
      }
    );

    /**
     * One savepoint per attempt: a unique violation inside the caller's
     * transaction then rolls back only this attempt, not the whole command.
     */
    const insertOnce = (draft: ArticleDraft, slug: Slug) =>
      sqlClient
        .withTransaction(
          Effect.gen(function* insertAttempt() {
            const row = yield* db
              .insert(article)
              .values({
                authorId: draft.authorId,
                body: draft.body,
                createdAt: DateTime.toDateUtc(draft.createdAt),
                imageLargeKey: draft.imageLargeKey,
                imageSmallKey: draft.imageSmallKey,
                published: draft.published,
                slug,
                sticky: draft.sticky,
                title: draft.title,
              })
              .returning(articleColumns)
              .pipe(Effect.flatMap(single));

            const departmentIds = Arr.dedupe(draft.departmentIds);

            if (Arr.isReadonlyArrayNonEmpty(departmentIds)) {
              yield* db.insert(articleDepartment).values(
                pipe(
                  departmentIds,
                  Arr.map((departmentId) => ({
                    articleId: row.id,
                    departmentId,
                  }))
                )
              );
            }

            return row;
          })
        )
        .pipe(Effect.catch((error) => classifySqlFailure(error, slug)));

    /**
     * RULE-096 race: the domain picked a free slug, but a concurrent create may
     * take it first. The unique constraint refuses the second insert; one retry
     * re-reads the taken slugs and picks the next suffix. A second collision
     * surfaces as `AlreadyExists`.
     */
    const create = Effect.fn("ArticleRepository.create")(function* create(
      draft: ArticleDraft
    ) {
      const row = yield* insertOnce(draft, draft.slug).pipe(
        Effect.catchTag("AlreadyExists", () =>
          Effect.flatMap(slugsLike(slugify(draft.title)), (taken) =>
            insertOnce(draft, uniqueSlug(draft.title, taken))
          )
        )
      );

      return yield* one([row]);
    });

    const findById = Effect.fn("ArticleRepository.findById")(function* findById(
      id: ArticleId
    ) {
      const rows = yield* db
        .select(articleColumns)
        .from(article)
        .where(eq(article.id, id))
        .pipe(Effect.orDie);

      return yield* oneById(id, rows);
    });

    const findBySlug = Effect.fn("ArticleRepository.findBySlug")(
      function* findBySlug(slug: Slug) {
        const rows = yield* db
          .select(articleColumns)
          .from(article)
          .where(eq(article.slug, slug))
          .pipe(Effect.orDie);

        return rows.length === 0
          ? Option.none()
          : Option.some(yield* one(rows));
      }
    );

    const setPublished = Effect.fn("ArticleRepository.setPublished")(
      function* setPublished(id: ArticleId, published: boolean) {
        const rows = yield* db
          .update(article)
          .set({ published })
          .where(eq(article.id, id))
          .returning(articleColumns)
          .pipe(Effect.orDie);

        return yield* oneById(id, rows);
      }
    );

    return ArticleRepository.of({
      create,
      findById,
      findBySlug,
      listPublished: db
        .select(articleColumns)
        .from(article)
        .where(eq(article.published, true))
        .pipe(
          Effect.orDie,
          Effect.flatMap(withDepartments),
          Effect.withSpan("ArticleRepository.listPublished")
        ),
      setPublished,
      slugsLike,
    });
  })
);

const staticContentColumns = {
  html: staticContent.html,
  key: staticContent.key,
};

export const StaticContentRepositoryLive = Layer.effect(
  StaticContentRepository,
  Effect.gen(function* StaticContentRepositoryLive() {
    const db = yield* Drizzle;
    const decode = decodeWith(StaticContent);
    const decodeOptional = decodeFirstOption(decode);

    const find = Effect.fn("StaticContentRepository.find")(function* find(
      key: StaticContentKey
    ) {
      const rows = yield* db
        .select(staticContentColumns)
        .from(staticContent)
        .where(eq(staticContent.key, key))
        .pipe(Effect.orDie);

      return yield* decodeOptional(rows);
    });

    /** RULE-296: replaces the block, creating it when missing, in one statement. */
    const upsert = Effect.fn("StaticContentRepository.upsert")(function* upsert(
      key: StaticContentKey,
      html: SanitizedHtml
    ) {
      const rows = yield* db
        .insert(staticContent)
        .values({ html, key })
        .onConflictDoUpdate({
          set: { html: sql`excluded.html` },
          target: staticContent.key,
        })
        .returning(staticContentColumns)
        .pipe(Effect.orDie);

      return yield* decode(yield* single(rows));
    });

    return StaticContentRepository.of({ find, upsert });
  })
);

const sponsorColumns = {
  id: sponsor.id,
  logoKey: sponsor.logoKey,
  name: sponsor.name,
  size: sponsor.size,
  url: sponsor.url,
};

export const SponsorRepositoryLive = Layer.effect(
  SponsorRepository,
  Effect.gen(function* SponsorRepositoryLive() {
    const db = yield* Drizzle;
    const decode = decodeWith(Sponsor);
    const decodeAll = decodeWith(Schema.Array(Sponsor));

    const create = Effect.fn("SponsorRepository.create")(function* create(
      draft: SponsorDraft
    ) {
      const rows = yield* db
        .insert(sponsor)
        .values(draft)
        .returning(sponsorColumns)
        .pipe(Effect.orDie);

      return yield* decode(yield* single(rows));
    });

    return SponsorRepository.of({
      create,
      list: db
        .select(sponsorColumns)
        .from(sponsor)
        .pipe(
          Effect.orDie,
          Effect.flatMap(decodeAll),
          Effect.withSpan("SponsorRepository.list")
        ),
    });
  })
);

/** A social event row as stored: the window bounds are `Date`s from the driver. */
const SocialEventRow = Schema.Struct({
  ...SocialEvent.fields,
  endsAt: Schema.DateTimeUtcFromDate,
  startsAt: Schema.DateTimeUtcFromDate,
});

const socialEventColumns = {
  departmentId: socialEvent.departmentId,
  description: socialEvent.description,
  endsAt: socialEvent.endsAt,
  id: socialEvent.id,
  link: socialEvent.link,
  semesterId: socialEvent.semesterId,
  startsAt: socialEvent.startsAt,
  title: socialEvent.title,
};

export const SocialEventRepositoryLive = Layer.effect(
  SocialEventRepository,
  Effect.gen(function* SocialEventRepositoryLive() {
    const db = yield* Drizzle;
    const decode = decodeWith(SocialEventRow);
    const decodeAll = decodeWith(Schema.Array(SocialEventRow));

    const list = Effect.fn("SocialEventRepository.list")(
      function* list(filter: {
        readonly departmentId: DepartmentId;
        readonly semesterId: SemesterId;
      }) {
        const rows = yield* db
          .select(socialEventColumns)
          .from(socialEvent)
          .where(
            and(
              eq(socialEvent.departmentId, filter.departmentId),
              eq(socialEvent.semesterId, filter.semesterId)
            )
          )
          .pipe(Effect.orDie);

        return yield* decodeAll(rows);
      }
    );

    const create = Effect.fn("SocialEventRepository.create")(function* create(
      draft: SocialEventDraft
    ) {
      const rows = yield* db
        .insert(socialEvent)
        .values({
          ...draft,
          endsAt: DateTime.toDateUtc(draft.endsAt),
          startsAt: DateTime.toDateUtc(draft.startsAt),
        })
        .returning(socialEventColumns)
        .pipe(Effect.orDie);

      return yield* decode(yield* single(rows));
    });

    return SocialEventRepository.of({ create, list });
  })
);
