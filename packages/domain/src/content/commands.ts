/**
 * Content commands (staff writes: require `InTransaction`, authorize, validate,
 * write, audit) and public queries (no transaction, no actor).
 */
import { Array as Arr, DateTime, Effect, Option, Order, Schema } from "effect";
import { recordAudit } from "../audit/auditLog.ts";
import { requireRegisteredImage } from "../files/commands.ts";
import { Capability, requireCapability, requireStaff } from "../shared/capabilities.ts";
import { NotFound } from "../shared/errors.ts";
import type { ArticleId, DepartmentId } from "../shared/ids.ts";
import { InTransaction } from "../shared/transaction.ts";
import { decodeInput } from "../shared/validation.ts";
import {
  ArticleInput,
  articleSavedNotice,
  isPubliclyVisible,
  isVisibleForDepartment,
  paginate,
  selectFrontPageNews,
} from "./article.ts";
import { sanitizeRichText } from "./sanitizer.ts";
import {
  ArticleRepository,
  SocialEventRepository,
  SponsorRepository,
  StaticContentRepository,
} from "./services.ts";
import { Slug, slugify, uniqueSlug } from "./slug.ts";
import { SocialEventInput } from "./socialEvent.ts";
import { SponsorInput, sortSponsorsForFooter } from "./sponsor.ts";
import { StaticContentUpdate, type StaticContentKey } from "./staticContent.ts";

const decodeStaticContentUpdate = decodeInput(StaticContentUpdate);
const decodeArticleInput = decodeInput(ArticleInput);
const decodeSponsorInput = decodeInput(SponsorInput);
const decodeSocialEventInput = decodeInput(SocialEventInput);
const decodeSlug = Schema.decodeUnknownOption(Slug);

/**
 * RULE-296: only an admin or an executive-board member edits a static block;
 * the HTML replaces the block (creating it if missing) after sanitizing
 * (RULE-133 replacement). A missing editor id is `ValidationFailed`.
 */
export const updateStaticContent = Effect.fn("updateStaticContent")(function* (input: unknown) {
  yield* InTransaction;
  const actor = yield* requireCapability(Capability.EditStaticContent());
  const update = yield* decodeStaticContentUpdate(input);
  const blocks = yield* StaticContentRepository;
  const saved = yield* blocks.upsert(update.editorId, sanitizeRichText(update.html ?? ""));
  yield* recordAudit(actor, "staticContent.updated", "StaticContent", saved.key);
  return saved;
});

/** C4 read: a block for embedding in a public page. */
export const getStaticContent = Effect.fn("getStaticContent")(function* (key: StaticContentKey) {
  const blocks = yield* StaticContentRepository;
  return yield* blocks.find(key);
});

/**
 * RULE-182: a new article needs both images (registered images, RULE-130);
 * RULE-096: unique slug; RULE-266 fixed: the audit entry and the notice say
 * "draft" for drafts.
 */
export const createArticle = Effect.fn("createArticle")(function* (input: unknown) {
  yield* InTransaction;
  const actor = yield* requireCapability(Capability.ManageArticles());
  const article = yield* decodeArticleInput(input);
  yield* requireRegisteredImage(article.imageSmallKey, ["imageSmallKey"]);
  yield* requireRegisteredImage(article.imageLargeKey, ["imageLargeKey"]);
  const articles = yield* ArticleRepository;
  const slug = uniqueSlug(article.title, yield* articles.slugsLike(slugify(article.title)));
  const created = yield* articles.create({
    title: article.title,
    slug,
    body: sanitizeRichText(article.body),
    imageSmallKey: article.imageSmallKey,
    imageLargeKey: article.imageLargeKey,
    sticky: article.sticky,
    published: article.published,
    departmentIds: article.departmentIds,
    authorId: actor.userId,
    createdAt: yield* DateTime.now,
  });
  yield* recordAudit(
    actor,
    created.published ? "article.createdPublished" : "article.createdDraft",
    "Article",
    created.id,
  );
  return { article: created, notice: articleSavedNotice(created) };
});

/** Publish or unpublish; the audit entry records which. */
export const setArticlePublished = Effect.fn("setArticlePublished")(function* (
  id: ArticleId,
  published: boolean,
) {
  yield* InTransaction;
  const actor = yield* requireCapability(Capability.ManageArticles());
  const articles = yield* ArticleRepository;
  const updated = yield* articles.setPublished(id, published);
  yield* recordAudit(
    actor,
    published ? "article.published" : "article.unpublished",
    "Article",
    updated.id,
  );
  return updated;
});

/** RULE-267: a draft (or unknown slug) is `NotFound` on the public site. */
export const getPublicArticle = Effect.fn("getPublicArticle")(function* (rawSlug: string) {
  const notFound = new NotFound({ entity: "Article", key: rawSlug });
  const slug = decodeSlug(rawSlug);
  if (Option.isNone(slug)) return yield* notFound;
  const articles = yield* ArticleRepository;
  const article = yield* articles.findBySlug(slug.value);
  if (Option.isSome(article) && isPubliclyVisible(article.value)) return article.value;
  return yield* notFound;
});

/** Front-page carousel size (legacy `NUM_CAROUSEL_ARTICLES`). */
export const FRONT_PAGE_NEWS_LIMIT = 5;

/** RULE-331 at the current `Clock` instant. */
export const loadFrontPageNews = Effect.fn("loadFrontPageNews")(function* (
  limit: number = FRONT_PAGE_NEWS_LIMIT,
) {
  const articles = yield* ArticleRepository;
  return selectFrontPageNews(yield* articles.listPublished, yield* DateTime.now, limit);
});

/** RULE-326: `/nyheter` and `/nyheter/{department}`, newest first, 10 per page. */
export const loadNewsPage = Effect.fn("loadNewsPage")(function* (query: {
  readonly page: number;
  readonly departmentId?: DepartmentId;
}) {
  const articles = yield* ArticleRepository;
  const { departmentId } = query;
  const visible = Arr.sort(
    Arr.filter(
      yield* articles.listPublished,
      (article) => departmentId === undefined || isVisibleForDepartment(article, departmentId),
    ),
    Order.mapInput(
      Order.flip(DateTime.Order),
      (article: { readonly createdAt: DateTime.Utc }) => article.createdAt,
    ),
  );
  return paginate(visible, query.page);
});

/** RULE-189 (URL format and logo type fixed). */
export const createSponsor = Effect.fn("createSponsor")(function* (input: unknown) {
  yield* InTransaction;
  const actor = yield* requireCapability(Capability.ManageSponsors());
  const sponsor = yield* decodeSponsorInput(input);
  if (sponsor.logoKey !== null) yield* requireRegisteredImage(sponsor.logoKey, ["logoKey"]);
  const sponsors = yield* SponsorRepository;
  const created = yield* sponsors.create(sponsor);
  yield* recordAudit(actor, "sponsor.created", "Sponsor", created.id);
  return created;
});

/** Footer sponsors, large first. */
export const listSponsorsForFooter = Effect.gen(function* () {
  const sponsors = yield* SponsorRepository;
  return sortSponsorsForFooter(yield* sponsors.list);
}).pipe(Effect.withSpan("listSponsorsForFooter"));

/** RULE-188: saved for the chosen department and semester; no role field. */
export const createSocialEvent = Effect.fn("createSocialEvent")(function* (input: unknown) {
  yield* InTransaction;
  yield* requireStaff;
  const event = yield* decodeSocialEventInput(input);
  const actor = yield* requireCapability(
    Capability.ManageSocialEvents({ departmentId: event.departmentId }),
  );
  const events = yield* SocialEventRepository;
  const created = yield* events.create(event);
  yield* recordAudit(actor, "socialEvent.created", "SocialEvent", created.id);
  return created;
});
