/** Content repositories (C4, C5, C6, C8). `packages/db` implements them as Layers. */
import { Context } from "effect";
import type { Effect, Option } from "effect";

import type { AlreadyExists, NotFound } from "../shared/errors.ts";
import type { ArticleId, DepartmentId, SemesterId } from "../shared/ids.ts";
import type { Article, ArticleDraft } from "./article.ts";
import type { SanitizedHtml } from "./sanitizer.ts";
import type { Slug } from "./slug.ts";
import type { SocialEvent, SocialEventDraft } from "./socialEvent.ts";
import type { Sponsor, SponsorDraft } from "./sponsor.ts";
import type { StaticContent, StaticContentKey } from "./staticContent.ts";

export class ArticleRepository extends Context.Service<
  ArticleRepository,
  {
    /** Fails with `AlreadyExists` on the unique slug constraint (a concurrent create took it). */
    readonly create: (
      draft: ArticleDraft
    ) => Effect.Effect<Article, AlreadyExists>;
    readonly findById: (id: ArticleId) => Effect.Effect<Article, NotFound>;
    readonly findBySlug: (slug: Slug) => Effect.Effect<Option.Option<Article>>;
    /** Existing slugs equal to `base` or starting with `base-` (RULE-096 input). */
    readonly slugsLike: (base: Slug) => Effect.Effect<readonly Slug[]>;
    /** Published articles only, any order (volume is tens of rows; rules order and page them). */
    readonly listPublished: Effect.Effect<readonly Article[]>;
    readonly setPublished: (
      id: ArticleId,
      published: boolean
    ) => Effect.Effect<Article, NotFound>;
  }
>()("@vektorprogrammet/domain/content/ArticleRepository") {}

export class StaticContentRepository extends Context.Service<
  StaticContentRepository,
  {
    readonly find: (
      key: StaticContentKey
    ) => Effect.Effect<Option.Option<StaticContent>>;
    /** RULE-296: replaces the block's HTML, creating the block if it does not exist. */
    readonly upsert: (
      key: StaticContentKey,
      html: SanitizedHtml
    ) => Effect.Effect<StaticContent>;
  }
>()("@vektorprogrammet/domain/content/StaticContentRepository") {}

export class SponsorRepository extends Context.Service<
  SponsorRepository,
  {
    readonly list: Effect.Effect<readonly Sponsor[]>;
    readonly create: (draft: SponsorDraft) => Effect.Effect<Sponsor>;
  }
>()("@vektorprogrammet/domain/content/SponsorRepository") {}

export class SocialEventRepository extends Context.Service<
  SocialEventRepository,
  {
    readonly list: (filter: {
      readonly departmentId: DepartmentId;
      readonly semesterId: SemesterId;
    }) => Effect.Effect<readonly SocialEvent[]>;
    readonly create: (draft: SocialEventDraft) => Effect.Effect<SocialEvent>;
  }
>()("@vektorprogrammet/domain/content/SocialEventRepository") {}
