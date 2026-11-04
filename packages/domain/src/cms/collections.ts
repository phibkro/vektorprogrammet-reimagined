/** Shared content collection schemas, decoded at the boundary. */
import { Schema, SchemaGetter } from "effect";

import { PortableText } from "./portableText.ts";

const Rest = Schema.Record(Schema.String, Schema.Json);

/** Accept boolean values and their integer representation. */
const IntegerBoolean = Schema.Union([
  Schema.Boolean,
  Schema.Literals([0, 1]).pipe(
    Schema.decodeTo(Schema.Boolean, {
      decode: SchemaGetter.transform((value) => value === 1),
      encode: SchemaGetter.transform((value) => (value ? 1 : 0)),
    })
  ),
]);

/** An image field with its media reference and metadata. */
export const ImageValue = Schema.StructWithRest(
  Schema.Struct({
    alt: Schema.optionalKey(Schema.String),
    height: Schema.optionalKey(Schema.Finite),
    id: Schema.String,
    src: Schema.optionalKey(Schema.String),
    width: Schema.optionalKey(Schema.Finite),
  }),
  [Rest]
);

export type ImageValue = typeof ImageValue.Type;

const optional = <S extends Schema.Constraint>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema));

/** `texts`: one editable text. The entry's slug is its key (the legacy `static_content.html_id`). */
export const TextData = Schema.StructWithRest(
  Schema.Struct({
    content: optional(PortableText),
    title: Schema.String,
  }),
  [Rest]
);

export type TextData = typeof TextData.Type;

/** `news`: an article. The publication date is the entry's `publishedAt`. */
export const NewsData = Schema.StructWithRest(
  Schema.Struct({
    content: optional(PortableText),
    /** City names of the departments the article is for; empty or absent means every department. */
    departments: optional(Schema.Array(Schema.String)),
    image: optional(ImageValue),
    sticky: optional(IntegerBoolean),
    title: Schema.String,
  }),
  [Rest]
);

export type NewsData = typeof NewsData.Type;

export const SponsorSize = Schema.Literals(["small", "medium", "large"]);

export type SponsorSize = typeof SponsorSize.Type;

/** `sponsors`: a sponsor or partner. */
export const SponsorData = Schema.StructWithRest(
  Schema.Struct({
    logo: optional(ImageValue),
    name: Schema.String,
    size: SponsorSize,
    url: Schema.String,
  }),
  [Rest]
);

export type SponsorData = typeof SponsorData.Type;

export const FaqPage = Schema.Literals(["assistenter", "team"]);

export type FaqPage = typeof FaqPage.Type;

/** `faq`: a question and its answer on the page named by `page`, in `position` order. */
export const FaqData = Schema.StructWithRest(
  Schema.Struct({
    answer: Schema.String,
    page: FaqPage,
    position: Schema.Int,
    question: Schema.String,
  }),
  [Rest]
);

export type FaqData = typeof FaqData.Type;

/** `teams`: a team of the department whose city is `department`. */
export const TeamData = Schema.StructWithRest(
  Schema.Struct({
    department: Schema.String,
    description: optional(Schema.String),
    email: optional(Schema.String),
    name: Schema.String,
    position: Schema.Int,
  }),
  [Rest]
);

export type TeamData = typeof TeamData.Type;

/** Content collections by slug. */
export const COLLECTIONS = {
  faq: FaqData,
  news: NewsData,
  sponsors: SponsorData,
  teams: TeamData,
  texts: TextData,
} as const;

export type CollectionName = keyof typeof COLLECTIONS;
