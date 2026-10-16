/**
 * What each EmDash collection of `apps/cms/seed/seed.json` holds in an entry's `data`, decoded once at the
 * boundary. EmDash's REST contract types `data` as free JSON (the shape depends on the collection), so these
 * schemas are the typed half of the contract; the seed is the other half, and `test/collections.test.ts` keeps
 * the two in step.
 *
 * EmDash quirks the schemas absorb: a boolean field reads back as 0 or 1, and a field that was never set is
 * absent (or null).
 */
import { Schema, SchemaGetter } from "effect";

import { PortableText } from "./portableText.ts";

/** A boolean column that EmDash answers as 0 or 1 (and accepts as either). */
const IntegerBoolean = Schema.Union([
  Schema.Boolean,
  Schema.Literals([0, 1]).pipe(
    Schema.decodeTo(Schema.Boolean, {
      decode: SchemaGetter.transform((value) => value === 1),
      encode: SchemaGetter.transform((value) => (value ? 1 : 0)),
    })
  ),
]);

/** An `image` field: the media reference plus the metadata EmDash caches with it. */
export const ImageValue = Schema.Struct({
  alt: Schema.optionalKey(Schema.String),
  height: Schema.optionalKey(Schema.Finite),
  id: Schema.String,
  src: Schema.optionalKey(Schema.String),
  width: Schema.optionalKey(Schema.Finite),
});

export type ImageValue = typeof ImageValue.Type;

const optional = <S extends Schema.Constraint>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema));

/** `texts`: one editable text. The entry's slug is its key (the legacy `static_content.html_id`). */
export const TextData = Schema.Struct({
  content: optional(PortableText),
  title: Schema.String,
});

export type TextData = typeof TextData.Type;

/** `news`: an article. The publication date is the entry's `publishedAt`. */
export const NewsData = Schema.Struct({
  content: optional(PortableText),
  /** City names of the departments the article is for; empty or absent means every department. */
  departments: optional(Schema.Array(Schema.String)),
  image: optional(ImageValue),
  sticky: optional(IntegerBoolean),
  title: Schema.String,
});

export type NewsData = typeof NewsData.Type;

export const SponsorSize = Schema.Literals(["small", "medium", "large"]);

export type SponsorSize = typeof SponsorSize.Type;

/** `sponsors`: a sponsor or partner. */
export const SponsorData = Schema.Struct({
  logo: optional(ImageValue),
  name: Schema.String,
  size: SponsorSize,
  url: Schema.String,
});

export type SponsorData = typeof SponsorData.Type;

export const FaqPage = Schema.Literals(["assistenter", "team"]);

export type FaqPage = typeof FaqPage.Type;

/** `faq`: a question and its answer on the page named by `page`, in `position` order. */
export const FaqData = Schema.Struct({
  answer: Schema.String,
  page: FaqPage,
  position: Schema.Int,
  question: Schema.String,
});

export type FaqData = typeof FaqData.Type;

/** `teams`: a team of the department whose city is `department`. */
export const TeamData = Schema.Struct({
  department: Schema.String,
  description: optional(Schema.String),
  email: optional(Schema.String),
  name: Schema.String,
  position: Schema.Int,
});

export type TeamData = typeof TeamData.Type;

/** The collections of `apps/cms/seed/seed.json`, by slug. */
export const COLLECTIONS = {
  faq: FaqData,
  news: NewsData,
  sponsors: SponsorData,
  teams: TeamData,
  texts: TextData,
} as const;

export type CollectionName = keyof typeof COLLECTIONS;
