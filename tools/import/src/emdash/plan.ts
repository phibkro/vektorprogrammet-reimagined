/**
 * The EmDash half of the import (spec 0005, D5): the legacy articles, static texts and sponsors as CMS entries.
 * Pure: no I/O, no clock, no randomness; the same snapshot gives the same plan.
 *
 * - Articles keep their legacy slug and `created` date, which is also the publication date. `published = 1`
 *   becomes a published entry; a draft (`0` or NULL, RULE-267) stays a draft. A department tag becomes the
 *   department's city, which is what `news.departments` holds. The legacy author id is dropped: EmDash authors
 *   are CMS users.
 * - A static text keeps its `html_id` as the entry slug, and gets a title for the editor from `TEXT_TITLES`.
 * - A sponsor gets the slug `sponsor-{id}`; sponsors are always published.
 * - Rich text goes through the domain sanitizer, then `htmlToPortableText`. Images are dropped and counted: the
 *   files are not copied yet (the file migration is not authorised), so an image has nothing to point at.
 * - A row that breaks a rule of its collection is quarantined with its reasons and never repaired by guessing.
 *   Reasons hold column names and ids only, never values: the report must not carry personal data.
 */
import type {
  NewEntry,
  NewsData,
  SponsorData,
  TextData,
} from "@vektorprogrammet/cms-client";
import { sanitizeRichText } from "@vektorprogrammet/domain";
import type { DateTime } from "effect";
import { Array as Arr, HashMap, Option, Result } from "effect";

import type { LegacySnapshot } from "../legacy/rows.ts";
import {
  addEmptyTextReason,
  addReason,
  articleReasons,
  isHttpUrl,
  isSponsorSize,
  isStaticContentKey,
  parseLegacyDateTime,
} from "../transform/plan.ts";
import { htmlToPortableText } from "./portableText.ts";

/** The collections the importer fills, with the legacy table each comes from. */
export const CMS_COLLECTIONS = [
  { collection: "news", source: "article" },
  { collection: "texts", source: "static_content" },
  { collection: "sponsors", source: "sponsor" },
] as const;

export type ImportedCollection = (typeof CMS_COLLECTIONS)[number]["collection"];

/** An entry to create, with the legacy id it came from and whether it goes live. */
export interface PlannedEntry<A> extends NewEntry<A> {
  readonly legacyId: string;
  readonly publish: boolean;
}

export interface QuarantinedEntry {
  readonly collection: ImportedCollection;
  /** The legacy id. */
  readonly id: string;
  /** Column names and ids only, never values. */
  readonly reasons: readonly string[];
}

export interface EmDashPlan {
  readonly news: readonly PlannedEntry<NewsData>[];
  readonly texts: readonly PlannedEntry<TextData>[];
  readonly sponsors: readonly PlannedEntry<SponsorData>[];
  readonly rowsIn: Readonly<Record<ImportedCollection, number>>;
  readonly quarantine: readonly QuarantinedEntry[];
  readonly droppedImages: {
    /** Articles that had an image column set (large and small are one image). */
    readonly articles: number;
    /** `<img>` elements in rich text. */
    readonly richText: number;
    /** Sponsors that had a logo path. */
    readonly sponsors: number;
  };
  /** Department tags that name a department the snapshot does not hold. */
  readonly danglingDepartmentTags: number;
}

/** The editor's title for each static text key that the legacy templates used; any other key is its own title. */
const TEXT_TITLES = HashMap.fromIterable<string, string>([
  ["about-faq", "Om oss: vanlige spørsmål"],
  ["about-header", "Om oss: ingress"],
  ["about-motivate-children", "Om oss: motiver elevene"],
  ["about-motivate-students", "Om oss: motiver studentene"],
  ["about-try-teaching", "Om oss: prøv deg som lærer"],
  ["contact-header", "Kontakt: ingress"],
  ["home-tagline", "Hjem: undertittel"],
  ["parent-assistants-info", "Foreldre: om assistentene"],
  ["parent-course", "Foreldre: kurset"],
  ["parent-header", "Foreldre: ingress"],
  ["vektor_i_media", "Vektor i media"],
]);

/** A CMS slug: what EmDash accepts in the URL of an entry. */
const CMS_SLUG = /^[a-z0-9][a-z0-9_-]*$/u;

const hasText = (value: string | null): value is string =>
  value !== null && value.trim() !== "";

/**
 * Builds the plan. Texts and sponsors have no legacy date, so they are created at `importedAt`; the clock is the
 * caller's, which keeps this function pure.
 */
export const planEmDashContent = (
  snapshot: LegacySnapshot,
  importedAt: DateTime.Utc
): EmDashPlan => {
  const quarantine: QuarantinedEntry[] = [];
  let richTextImages = 0;
  let articleImages = 0;
  let sponsorLogos = 0;
  let danglingDepartmentTags = 0;

  const quarantineWhen = (
    collection: ImportedCollection,
    id: string,
    reasons: readonly string[]
  ): boolean => {
    if (reasons.length > 0) {
      quarantine.push({ collection, id, reasons });
    }

    return reasons.length > 0;
  };

  const richText = (html: string) => {
    const { blocks, imagesDropped } = htmlToPortableText(
      sanitizeRichText(html)
    );

    richTextImages += imagesDropped;

    return blocks;
  };

  const cityOf = new Map(
    Arr.map(
      snapshot.departments,
      (department) => [department.id, department.city] as const
    )
  );

  /** The cities an article is tagged with, in tag order, each once; none means every department. */
  const citiesOf = (articleId: number): readonly string[] =>
    Arr.dedupe(
      Arr.filterMap(
        Arr.filter(
          snapshot.articleDepartments,
          (tag) => tag.articleId === articleId
        ),
        (tag) => {
          const city = cityOf.get(tag.departmentId);

          if (city === undefined) {
            danglingDepartmentTags += 1;

            return Result.failVoid;
          }

          return Result.succeed(city);
        }
      )
    );

  const buildNews = () => {
    const entries: PlannedEntry<NewsData>[] = [];
    const slugs = new Map<string, number>();

    for (const row of snapshot.articles) {
      const id = String(row.id);
      const createdAt = parseLegacyDateTime(row.created);

      if (
        quarantineWhen("news", id, articleReasons(row, slugs.get(row.slug))) ||
        createdAt === undefined
      ) {
        continue;
      }

      slugs.set(row.slug, row.id);
      articleImages +=
        hasText(row.imageLarge) || hasText(row.imageSmall) ? 1 : 0;

      entries.push({
        createdAt,
        data: {
          content: richText(row.body),
          departments: citiesOf(row.id),
          sticky: row.sticky === 1,
          title: row.title,
        },
        legacyId: id,
        publish: row.published === 1,
        publishedAt: createdAt,
        slug: row.slug,
      });
    }

    return entries;
  };

  const buildTexts = () => {
    const entries: PlannedEntry<TextData>[] = [];
    const keys = new Map<string, number>();

    for (const row of snapshot.staticContents) {
      const id = String(row.id);
      const reasons: string[] = [];
      const first = keys.get(row.htmlId);

      addReason(
        reasons,
        !isStaticContentKey(row.htmlId) || !CMS_SLUG.test(row.htmlId),
        "html_id is not a CMS slug ([a-z0-9_-], at most 50)"
      );
      addReason(
        reasons,
        first !== undefined,
        `html_id duplicates static_content ${first}`
      );

      if (quarantineWhen("texts", id, reasons)) {
        continue;
      }

      keys.set(row.htmlId, row.id);

      entries.push({
        createdAt: importedAt,
        data: {
          content: richText(row.html),
          title: Option.getOrElse(
            HashMap.get(TEXT_TITLES, row.htmlId),
            () => row.htmlId
          ),
        },
        legacyId: id,
        publish: true,
        publishedAt: importedAt,
        slug: row.htmlId,
      });
    }

    return entries;
  };

  const buildSponsors = () => {
    const entries: PlannedEntry<SponsorData>[] = [];

    for (const row of snapshot.sponsors) {
      const id = String(row.id);
      const reasons: string[] = [];

      addEmptyTextReason(reasons, "name", row.name ?? "");
      addReason(
        reasons,
        row.url === null || !isHttpUrl(row.url),
        "url is not an absolute http(s) URL"
      );
      addReason(
        reasons,
        row.size === null || !isSponsorSize(row.size),
        "size is not small, medium or large"
      );

      if (
        quarantineWhen("sponsors", id, reasons) ||
        row.name === null ||
        row.url === null ||
        row.size === null ||
        !isSponsorSize(row.size)
      ) {
        continue;
      }

      sponsorLogos += hasText(row.logoImagePath) ? 1 : 0;

      entries.push({
        createdAt: importedAt,
        data: { name: row.name, size: row.size, url: row.url },
        legacyId: id,
        publish: true,
        publishedAt: importedAt,
        slug: `sponsor-${row.id}`,
      });
    }

    return entries;
  };

  const news = buildNews();
  const texts = buildTexts();
  const sponsors = buildSponsors();

  return {
    danglingDepartmentTags,
    droppedImages: {
      articles: articleImages,
      richText: richTextImages,
      sponsors: sponsorLogos,
    },
    news,
    quarantine,
    rowsIn: {
      news: snapshot.articles.length,
      sponsors: snapshot.sponsors.length,
      texts: snapshot.staticContents.length,
    },
    sponsors,
    texts,
  };
};
