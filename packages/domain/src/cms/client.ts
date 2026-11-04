import type { DateTime, Effect, Option } from "effect";
import { Context, Data, Schema } from "effect";

import type {
  CollectionName,
  FaqData,
  NewsData,
  SponsorData,
  TeamData,
  TextData,
} from "./collections.ts";

export class CmsUnavailable extends Schema.TaggedError<
  CmsUnavailable,
  { readonly brand: unique symbol }
>()("CmsUnavailable", {
  operation: Schema.String,
  reason: Schema.String,
  status: Schema.optionalKey(Schema.Int),
}) {}

export class CmsRejected extends Schema.TaggedError<
  CmsRejected,
  { readonly brand: unique symbol }
>()("CmsRejected", {
  code: Schema.String,
  message: Schema.String,
  operation: Schema.String,
  status: Schema.Int,
}) {}

export class CmsInvalidContent extends Schema.TaggedError<
  CmsInvalidContent,
  { readonly brand: unique symbol }
>()("CmsInvalidContent", {
  collection: Schema.String,
  message: Schema.String,
  slug: Schema.NullOr(Schema.String),
}) {}

export type CmsFailure = CmsUnavailable | CmsRejected | CmsInvalidContent;

export interface Entry<A> {
  readonly id: string;
  readonly slug: string | null;
  readonly data: A;
  readonly createdAt: DateTime.Utc;
  readonly publishedAt: DateTime.Utc | null;
}

export interface Listing {
  readonly id: string;
  readonly slug: string | null;
  readonly status: string;
}

export interface NewEntry<A> {
  readonly slug: string;
  readonly data: A;
  readonly createdAt: DateTime.Utc;
  readonly publishedAt: DateTime.Utc;
}

export type CreateOutcome = Data.TaggedEnum<{
  Created: { readonly id: string };
  SlugTaken: object;
}>;

export const CreateOutcome = Data.taggedEnum<CreateOutcome>();

export interface Collection<A> {
  readonly published: Effect.Effect<readonly Entry<A>[], CmsFailure>;
  readonly publishedBySlug: (
    slug: string
  ) => Effect.Effect<Option.Option<Entry<A>>, CmsFailure>;
  readonly listings: Effect.Effect<readonly Listing[], CmsFailure>;
  readonly create: (
    entry: NewEntry<A>
  ) => Effect.Effect<CreateOutcome, CmsFailure>;
  readonly publish: (id: string) => Effect.Effect<void, CmsFailure>;
}

export class CmsClient extends Context.Service<
  CmsClient,
  {
    readonly texts: Collection<TextData>;
    readonly news: Collection<NewsData>;
    readonly sponsors: Collection<SponsorData>;
    readonly faq: Collection<FaqData>;
    readonly teams: Collection<TeamData>;
  }
>()("@vektorprogrammet/domain/cms/CmsClient") {}

export interface ContentDraft {
  readonly collection: CollectionName;
  readonly slug: string;
  readonly draft: Schema.Json;
  readonly published: Schema.Json | null;
  readonly createdAt: string;
  readonly publishedAt: string | null;
}

export class ContentEditor extends Context.Service<
  ContentEditor,
  {
    readonly list: Effect.Effect<readonly ContentDraft[], CmsFailure>;
    readonly save: (
      collection: CollectionName,
      slug: string,
      data: Schema.Json
    ) => Effect.Effect<void, CmsFailure>;
    readonly publish: (
      collection: CollectionName,
      slug: string
    ) => Effect.Effect<void, CmsFailure>;
    readonly create: (
      collection: CollectionName,
      slug: string,
      data: Schema.Json
    ) => Effect.Effect<void, CmsFailure>;
  }
>()("@vektorprogrammet/domain/cms/ContentEditor") {}
