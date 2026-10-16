/**
 * An in-memory CMS: `CmsClient` over a Map per collection. It behaves like EmDash where the importer depends on
 * it: `create` makes a draft, a slug that exists answers `SlugTaken`, `publish` turns a draft into a published
 * entry, `listings` shows every entry with its status. Tests inspect `stored` afterwards; the real EmDash is
 * exercised by `apps/web/e2e`.
 */
import { CmsClient, CreateOutcome } from "@vektorprogrammet/cms-client";
import type {
  CmsFailure,
  Collection,
  FaqData,
  NewEntry,
  NewsData,
  SponsorData,
  TeamData,
  TextData,
} from "@vektorprogrammet/cms-client";
import { Array as Arr, Effect, Layer, Option } from "effect";

interface Stored<A> {
  readonly id: string;
  status: "draft" | "published";
  readonly entry: NewEntry<A>;
}

interface FakeCollection<A> {
  readonly collection: Collection<A>;
  /** By slug. */
  readonly stored: Map<string, Stored<A>>;
}

const fakeCollection = <A>(
  failWith: (data: A) => Option.Option<CmsFailure> = () => Option.none()
): FakeCollection<A> => {
  const stored = new Map<string, Stored<A>>();

  const collection: Collection<A> = {
    create: (entry) =>
      Effect.suspend((): Effect.Effect<CreateOutcome, CmsFailure> => {
        const failure = failWith(entry.data);

        if (Option.isSome(failure)) {
          return Effect.fail(failure.value);
        }

        if (stored.has(entry.slug)) {
          return Effect.succeed(CreateOutcome.SlugTaken());
        }

        const id = `id-${stored.size + 1}`;
        stored.set(entry.slug, { entry, id, status: "draft" });

        return Effect.succeed(CreateOutcome.Created({ id }));
      }),
    listings: Effect.sync(() =>
      Arr.map(Arr.fromIterable(stored), ([slug, { id, status }]) => ({
        id,
        slug,
        status,
      }))
    ),
    publish: (id) =>
      Effect.sync(() => {
        for (const entry of stored.values()) {
          if (entry.id === id) {
            entry.status = "published";
          }
        }
      }),
    published: Effect.succeed([]),
    publishedBySlug: () => Effect.succeedNone,
  };

  return { collection, stored };
};

/** A fresh CMS. `failNews` makes `news.create` fail with the CMS failure it returns for an article. */
export const makeFakeCms = (
  failNews: (data: NewsData) => Option.Option<CmsFailure> = () => Option.none()
) => {
  const news = fakeCollection<NewsData>(failNews);
  const texts = fakeCollection<TextData>();
  const sponsors = fakeCollection<SponsorData>();
  const faq = fakeCollection<FaqData>();
  const teams = fakeCollection<TeamData>();
  /** `collection.field` → its options, in the order they were added. */
  const options = new Map<string, string[]>();

  return {
    layer: Layer.succeed(
      CmsClient,
      CmsClient.of({
        absoluteUrl: (path) => path,
        ensureOptions: (collection, field, values) =>
          Effect.sync(() => {
            const key = `${collection}.${field}`;
            const known = options.get(key) ?? [];

            const missing = Arr.filter(
              Arr.dedupe(values),
              (value) => !known.includes(value)
            );

            options.set(key, [...known, ...missing]);

            return missing.length;
          }),
        faq: faq.collection,
        news: news.collection,
        sponsors: sponsors.collection,
        teams: teams.collection,
        texts: texts.collection,
      })
    ),
    news,
    options,
    sponsors,
    texts,
  };
};
