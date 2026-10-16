/**
 * C5 news: the public read rules over published articles (RULE-331 front page, RULE-326 pagination).
 *
 * The articles themselves live in the CMS (spec 0005): an editor writes, saves a draft and publishes there, so the
 * model, the editor input (RULE-182), the unique slug (RULE-096) and the visibility of a draft (RULE-267) are the
 * CMS's. These two rules are what the public site still decides, over whatever list of articles it read.
 */
import { Array as Arr, DateTime, Order } from "effect";

import { addOsloCalendar, isBefore } from "../shared/clock.ts";

interface FrontPageSortFields {
  readonly sticky: boolean;
  readonly createdAt: DateTime.Utc;
}

interface FrontPageFields extends FrontPageSortFields {
  readonly published: boolean;
}

/** Sticky first, then newest first. */
export const FrontPageOrder: Order.Order<FrontPageSortFields> = Order.combine(
  Order.mapInput(
    Order.flip(Order.Boolean),
    (article: FrontPageSortFields) => article.sticky
  ),
  Order.mapInput(
    Order.flip(DateTime.Order),
    (article: FrontPageSortFields) => article.createdAt
  )
);

/** RULE-331: how far back the front page looks for non-sticky news. */
export const FRONT_PAGE_NEWS_DAYS = 30;

/**
 * RULE-331: published articles created within the last 30 days (Oslo calendar),
 * or sticky; sticky first, then newest first; at most `limit` when given.
 */
export const selectFrontPageNews = <A extends FrontPageFields>(
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
