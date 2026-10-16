/**
 * Writes an `EmDashPlan` to the CMS through `CmsClient`, and reads the collections back.
 *
 * Create-only: an entry whose slug exists is left as it is (`SlugTaken` → unchanged), so a rerun never
 * overwrites what an editor changed, and a second run of the same plan creates nothing. A new entry is created
 * as a draft with its original dates, then published when the legacy row was live. The CMS may refuse an entry
 * (`CmsRejected`, for example a department city that is not an option of `news.departments`): that is counted
 * with the CMS's error code and the run goes on. A CMS that cannot be reached stops the run.
 */
import { CmsClient, CreateOutcome } from "@vektorprogrammet/cms-client";
import type { Collection } from "@vektorprogrammet/cms-client";
import { Array as Arr, Data, Effect, Result } from "effect";

import type { EmDashPlan, ImportedCollection, PlannedEntry } from "./plan.ts";

/** The CMS refused an entry; only the operation and the CMS's error code are kept (never values). */
interface Rejection {
  readonly collection: ImportedCollection;
  /** The legacy id. */
  readonly id: string;
  readonly operation: "create" | "publish";
  readonly code: string;
}

/** What happened to one entry. */
type Step = Data.TaggedEnum<{
  /** Created and left as a draft. */
  Drafted: object;
  /** Created and published. */
  Published: object;
  /** The slug exists already. */
  Unchanged: object;
  Rejected: {
    readonly operation: "create" | "publish";
    readonly code: string;
  };
}>;

const Step = Data.taggedEnum<Step>();

interface CollectionResult {
  readonly collection: ImportedCollection;
  readonly drafted: number;
  readonly published: number;
  readonly unchanged: number;
  readonly rejections: readonly Rejection[];
  /** Read back after the writes: every entry of the collection, whoever created it. */
  readonly inCms: { readonly published: number; readonly draft: number };
}

const writeEntry = <A>(cms: Collection<A>, entry: PlannedEntry<A>) =>
  cms.create(entry).pipe(
    Effect.flatMap(
      CreateOutcome.$match({
        Created: ({ id }) =>
          entry.publish
            ? cms.publish(id).pipe(
                Effect.as(Step.Published()),
                Effect.catchTag("CmsRejected", (refusal) =>
                  Effect.succeed(
                    Step.Rejected({ code: refusal.code, operation: "publish" })
                  )
                )
              )
            : Effect.succeed(Step.Drafted()),
        SlugTaken: () => Effect.succeed(Step.Unchanged()),
      })
    ),
    Effect.catchTag("CmsRejected", (refusal) =>
      Effect.succeed(Step.Rejected({ code: refusal.code, operation: "create" }))
    )
  );

const writeCollection = Effect.fn("writeCollection")(function* writeCollection<
  A,
>(
  collection: ImportedCollection,
  cms: Collection<A>,
  entries: readonly PlannedEntry<A>[]
) {
  const steps = yield* Effect.forEach(entries, (entry) =>
    Effect.map(writeEntry(cms, entry), (step) => ({ entry, step }))
  );

  const listings = yield* cms.listings;

  const count = (tag: Step["_tag"]) =>
    Arr.filter(steps, ({ step }) => step._tag === tag).length;

  return {
    collection,
    drafted: count("Drafted"),
    inCms: {
      draft: Arr.filter(listings, (listing) => listing.status === "draft")
        .length,
      published: Arr.filter(
        listings,
        (listing) => listing.status === "published"
      ).length,
    },
    published: count("Published"),
    rejections: Arr.filterMap(steps, ({ entry, step }) =>
      Step.$is("Rejected")(step)
        ? Result.succeed({
            code: step.code,
            collection,
            id: entry.legacyId,
            operation: step.operation,
          })
        : Result.failVoid
    ),
    unchanged: count("Unchanged"),
  } satisfies CollectionResult;
});

/** What a run did to the CMS. */
export interface WrittenContent {
  readonly collections: Readonly<Record<ImportedCollection, CollectionResult>>;
  /** Department cities that were not yet options of `news.departments` and now are. */
  readonly departmentOptionsAdded: number;
}

/**
 * Writes news, texts and sponsors, in that order. The department cities the articles are tagged with first
 * become options of `news.departments`, so that every tag is a choice for editors and the CMS accepts it.
 */
export const writeContent = Effect.fn("writeContent")(function* writeContent(
  plan: EmDashPlan
) {
  const cms = yield* CmsClient;

  const cities = Arr.dedupe(
    Arr.flatMap(plan.news, (entry) => entry.data.departments ?? [])
  );

  const departmentOptionsAdded =
    cities.length === 0
      ? 0
      : yield* cms.ensureOptions("news", "departments", cities);

  const news = yield* writeCollection("news", cms.news, plan.news);
  const texts = yield* writeCollection("texts", cms.texts, plan.texts);

  const sponsors = yield* writeCollection(
    "sponsors",
    cms.sponsors,
    plan.sponsors
  );

  return {
    collections: { news, sponsors, texts },
    departmentOptionsAdded,
  } satisfies WrittenContent;
});
