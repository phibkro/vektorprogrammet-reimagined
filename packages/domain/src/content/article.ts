/**
 * C5 news articles: model, editor input (RULE-182) and the public read rules
 * (RULE-267 visibility, RULE-331 front page, RULE-326 pagination).
 */
import { Array as Arr, DateTime, Order, Schema } from "effect";

import { addOsloCalendar, isBefore } from "../shared/clock.ts";
import { ArticleId, DepartmentId, FileKey, UserId } from "../shared/ids.ts";
import { requiredText } from "../shared/validation.ts";
import { SanitizedHtmlFromString } from "./sanitizer.ts";
import { Slug } from "./slug.ts";

export const Article = Schema.Struct({
  /** Legacy author id; no foreign key until Phase 2. */
  authorId: Schema.NullOr(UserId),
  /** Sanitized on save and again on every decode (RULE-133 replacement). */
  body: SanitizedHtmlFromString,
  createdAt: Schema.DateTimeUtc,
  /** Departments the article is tagged with; empty means "all departments". */
  departmentIds: Schema.Array(DepartmentId),
  id: ArticleId,
  imageLargeKey: FileKey,
  imageSmallKey: FileKey,
  published: Schema.Boolean,
  slug: Slug,
  sticky: Schema.Boolean,
  title: Schema.String.check(Schema.isNonEmpty()),
});

export type Article = typeof Article.Type;

/** What `ArticleRepository.create` writes. */
export type ArticleDraft = Omit<Article, "id">;

export const ARTICLE_IMAGES_REQUIRED_MESSAGE =
  "Last opp både et lite og et stort bilde.";

/** RULE-182: a new article needs a title, a body and both images. */
export const ArticleInput = Schema.Struct({
  body: Schema.String,
  departmentIds: Schema.Array(DepartmentId),
  imageLargeKey: FileKey.annotateKey({
    messageMissingKey: ARTICLE_IMAGES_REQUIRED_MESSAGE,
  }),
  imageSmallKey: FileKey.annotateKey({
    messageMissingKey: ARTICLE_IMAGES_REQUIRED_MESSAGE,
  }),
  published: Schema.Boolean,
  sticky: Schema.Boolean,
  title: requiredText({ maxLength: 255 }),
});

export type ArticleInput = typeof ArticleInput.Type;

/** RULE-267: drafts are never public. */
export const isPubliclyVisible = (
  article: Pick<Article, "published">
): boolean => article.published;

/** `/nyheter/{department}`: tagged with the department, or untagged. */
export const isVisibleForDepartment = (
  article: Pick<Article, "departmentIds">,
  departmentId: DepartmentId
): boolean =>
  article.departmentIds.length === 0 ||
  article.departmentIds.includes(departmentId);

type FrontPageFields = Pick<Article, "sticky" | "createdAt">;

/** Sticky first, then newest first. */
export const FrontPageOrder: Order.Order<FrontPageFields> = Order.combine(
  Order.mapInput(
    Order.flip(Order.Boolean),
    (article: FrontPageFields) => article.sticky
  ),
  Order.mapInput(
    Order.flip(DateTime.Order),
    (article: FrontPageFields) => article.createdAt
  )
);

/** RULE-331: how far back the front page looks for non-sticky news. */
export const FRONT_PAGE_NEWS_DAYS = 30;

/**
 * RULE-331: published articles created within the last 30 days (Oslo calendar),
 * or sticky; sticky first, then newest first; at most `limit` when given.
 */
export const selectFrontPageNews = <
  A extends Pick<Article, "published" | "sticky" | "createdAt">,
>(
  articles: Iterable<A>,
  now: DateTime.DateTime,
  limit?: number
): A[] => {
  const cutoff = addOsloCalendar(now, { days: -FRONT_PAGE_NEWS_DAYS });

  const selected = Arr.sort(
    Arr.filter(
      Arr.fromIterable(articles),
      (article) =>
        article.published &&
        (article.sticky || isBefore(cutoff, article.createdAt))
    ),
    FrontPageOrder
  );

  return limit === undefined ? selected : selected.slice(0, limit);
};

/** RULE-326: articles per news page. */
export const NEWS_PAGE_SIZE = 10;

export interface Page<A> {
  readonly items: readonly A[];
  /** 1-based. */
  readonly page: number;
  readonly totalPages: number;
  readonly totalItems: number;
}

/** RULE-326: 1-based pages of `pageSize`; a page past the end is empty. */
export const paginate = <A>(
  items: readonly A[],
  page: number,
  pageSize: number = NEWS_PAGE_SIZE
): Page<A> => {
  const current = Math.max(1, Math.floor(page));

  return {
    items: items.slice((current - 1) * pageSize, current * pageSize),
    page: current,
    totalItems: items.length,
    totalPages: Math.ceil(items.length / pageSize),
  };
};

/** RULE-266 fixed: the editor notice says what actually happened. */
export const articleSavedNotice = (
  article: Pick<Article, "published">
): string =>
  article.published
    ? "Artikkelen har blitt publisert."
    : "Artikkelen er lagret som kladd.";
