/**
 * An in-memory CMS for apps/web tests: the `CmsClient` over seeded entries. Like the real client it shows a page
 * only the published entries (the real EmDash lets a token that can read also read drafts), and it implements the
 * writes the importer uses, so a test can publish an entry and watch a page program change without a deploy.
 * The HTTP client itself is tested in `packages/cms-client`; every value here is a fake same-shape value.
 */
import { CmsClient, CreateOutcome } from "@vektorprogrammet/cms-client";
import type {
  Collection,
  Entry,
  FaqData,
  NewsData,
  SponsorData,
  TeamData,
  TextData,
} from "@vektorprogrammet/cms-client";
import { Array as Arr, DateTime, Effect, Layer, Record as Rec } from "effect";

/** A seeded entry; a draft is kept by the CMS but never shown. */
export interface Seed<A> {
  readonly entry: Entry<A>;
  readonly status: "draft" | "published";
}

export interface CmsSeed {
  readonly texts: readonly Seed<TextData>[];
  readonly news: readonly Seed<NewsData>[];
  readonly sponsors: readonly Seed<SponsorData>[];
  readonly faq: readonly Seed<FaqData>[];
  readonly teams: readonly Seed<TeamData>[];
}

const EPOCH = DateTime.makeUnsafe(Date.UTC(2026, 0, 1));

/** A published entry made on `day` (days after 2026-01-01). */
export const published = <A>(slug: string, data: A, day = 0): Seed<A> => ({
  entry: {
    createdAt: DateTime.add(EPOCH, { days: day }),
    data,
    id: `id-${slug}`,
    publishedAt: DateTime.add(EPOCH, { days: day }),
    slug,
  },
  status: "published",
});

export const draft = <A>(slug: string, data: A, day = 0): Seed<A> => ({
  entry: { ...published(slug, data, day).entry, publishedAt: null },
  status: "draft",
});

interface Stored<A> {
  entry: Entry<A>;
  status: string;
}

const memoryCollection = <A>(seed: readonly Seed<A>[]): Collection<A> => {
  const rows: Stored<A>[] = Arr.map(seed, ({ entry, status }) => ({
    entry,
    status,
  }));

  const shown = () =>
    Arr.map(
      Arr.filter(rows, (row) => row.status === "published"),
      (row) => row.entry
    );

  return {
    create: (draftEntry) =>
      Effect.sync(() => {
        if (Arr.some(rows, (row) => row.entry.slug === draftEntry.slug)) {
          return CreateOutcome.SlugTaken();
        }

        const id = `id-${draftEntry.slug}`;
        rows.push({
          entry: {
            createdAt: draftEntry.createdAt,
            data: draftEntry.data,
            id,
            publishedAt: null,
            slug: draftEntry.slug,
          },
          status: "draft",
        });

        return CreateOutcome.Created({ id });
      }),
    listings: Effect.sync(() =>
      Arr.map(rows, (row) => ({
        id: row.entry.id,
        slug: row.entry.slug,
        status: row.status,
      }))
    ),
    publish: (id) =>
      Effect.sync(() => {
        for (const row of rows) {
          if (row.entry.id === id) {
            row.status = "published";
            row.entry = { ...row.entry, publishedAt: row.entry.createdAt };
          }
        }
      }),
    published: Effect.sync(shown),
    publishedBySlug: (slug) =>
      Effect.sync(() =>
        Arr.findFirst(shown(), (candidate) => candidate.slug === slug)
      ),
  };
};

/** The CMS with `seed` in it; a collection left out is empty. */
export const memoryCms = (seed: Partial<CmsSeed> = {}) => {
  const options = new Map<string, Set<string>>();

  return Layer.succeed(CmsClient, {
    absoluteUrl: (path) => new URL(path, "https://cms.test").toString(),
    ensureOptions: (collection, field, values) =>
      Effect.sync(() => {
        const key = `${collection}.${field}`;
        const known = options.get(key) ?? new Set<string>();
        const added = Arr.filter(values, (value) => !known.has(value));

        options.set(key, new Set([...known, ...values]));

        return added.length;
      }),
    faq: memoryCollection(seed.faq ?? []),
    news: memoryCollection(seed.news ?? []),
    sponsors: memoryCollection(seed.sponsors ?? []),
    teams: memoryCollection(seed.teams ?? []),
    texts: memoryCollection(seed.texts ?? []),
  });
};

/** The seeded texts by slot: `{ "home-tagline": [block] }` as published text entries. */
export const textsOf = (
  slots: Readonly<Record<string, TextData["content"]>>
): readonly Seed<TextData>[] =>
  Arr.map(Rec.toEntries(slots), ([slug, content]) =>
    published(slug, { content, title: slug })
  );

/** A Portable Text block of one paragraph, for asserting what a page shows. */
export const paragraph = (text: string) =>
  [
    {
      _type: "block",
      children: [{ _type: "span", text }],
      style: "normal",
    },
  ] as const;
