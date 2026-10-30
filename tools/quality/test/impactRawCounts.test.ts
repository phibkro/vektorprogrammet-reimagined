/**
 * Spec 0027 D5, F3: `release` is the only exit of a count from the impact domain. The type says part of it (a published
 * value is a `ReleasedCount`, which `releasedCount` alone makes: `release.types.test.ts`); this says the rest. A raw count
 * lives in three places, and only the files below may name them: the source that answers a cell (`ImpactSource`), the
 * snapshot that stores one (`ImpactSnapshots`), and the maker of a count that an output may hold (`releasedCount`). A file
 * that names one and is not listed is a new reader of raw counts, which must go through `release` or be listed here with
 * its reason in the change that adds it. An allowance that no file needs fails, so the list only shrinks.
 *
 * What it does not see: a file that reads a raw count through a name it does not write (a re-export, `Context.Tag` by key).
 * The package root exports `impact/services.ts` and `impact/source.ts` whole, so a name is reachable from anywhere; this is
 * the early signal at review time, not a guarantee, as `inTransactionProviders.test.ts` is for its own name.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, Order, Record as Rec } from "effect";

import type { Source } from "./support/sources.ts";
import { workingTreeSources } from "./support/sources.ts";

const root = new URL("../../../", import.meta.url).pathname.replace(/\/$/u, "");

/** The files of the source that may write one guarded name, each with why. */
type Allowance = Readonly<Record<string, string>>;

/** Each guarded name, and the files that may write it. */
type Allowances = Readonly<Record<string, Allowance>>;

const ALLOWED = {
  ImpactSnapshots: {
    "apps/web/src/server/runtime.ts":
      "the services type of the database layer lists the port; nothing is read",
    "packages/db/src/repositories/impact.ts":
      "the adapter that stores and reads the snapshot rows",
    "packages/domain/src/impact/commands.ts":
      "the handlers: `closeImpact` writes through the port and the report reads the snapshot into `release`",
    "packages/domain/src/impact/services.ts": "the declaration of the port",
    "packages/domain/src/shared/guarantees.ts":
      "IM1 and CL1 name the port's `close` as their carrier",
    "packages/domain/src/shared/transactionModes.ts":
      "the mode of each method of the port",
  },
  ImpactSource: {
    "apps/web/src/server/runtime.ts":
      "the services type of the database layer lists the port; nothing is read",
    "packages/db/src/repositories/impact.ts":
      "the adapter that answers a cell from the store (today: Unavailable)",
    "packages/domain/src/impact/commands.ts":
      "the handlers read the source into `release` and into the snapshot close",
    "packages/domain/src/impact/source.ts": "the declaration of the port",
    "packages/domain/src/shared/transactionModes.ts":
      "the mode of each method of the port",
  },
  releasedCount: {
    "packages/domain/src/impact/measures.ts": "the maker, and the brand's rule",
    "packages/domain/src/impact/release.ts":
      "the one caller: a count is published only through `release`",
  },
} satisfies Allowances;

const wholeWord = (name: string): RegExp => new RegExp(`\\b${name}\\b`, "u");

const names = Rec.keys(ALLOWED);

const allowanceOf = (name: keyof typeof ALLOWED): Allowance => ALLOWED[name];

/** The source files that the scan reads: the `src` of each package, app and tool, never its tests. */
const isSource = (path: string): boolean =>
  /^(?:packages|apps|tools)\/[^/]+\/src\/.*\.tsx?$/u.test(path);

/** `file names Name` for each file that writes a guarded name and is not allowed to. */
const unlisted = (sources: readonly Source[]): readonly string[] =>
  Arr.flatMap(sources, ({ path, text }) =>
    Arr.flatMap(names, (name) =>
      wholeWord(name).test(text) && allowanceOf(name)[path] === undefined
        ? [`${path} names ${name}`]
        : []
    )
  );

/** `file allowed for Name` for each allowance whose file does not name it. */
const stale = (sources: readonly Source[]): readonly string[] =>
  Arr.flatMap(names, (name) =>
    Arr.flatMap(Rec.keys(allowanceOf(name)), (path) =>
      Arr.some(
        sources,
        (source) => source.path === path && wholeWord(name).test(source.text)
      )
        ? []
        : [`${path} is allowed for ${name} and does not name it`]
    )
  );

describe("spec 0027 D5: only release lets a raw count out", () => {
  it("control: a file that reads the snapshots, the source or mints a count is reported, a listed one is not, a comment-free neighbour is not", () => {
    const sources: readonly Source[] = [
      {
        path: "apps/web/src/server/panelReads.ts",
        text: "const rows = yield* ImpactSnapshots; rows.read();",
      },
      {
        path: "apps/web/src/functions/panel.functions.ts",
        text: "const count = releasedCount(3, 1);",
      },
      {
        path: "packages/domain/src/impact/commands.ts",
        text: "yield* ImpactSource; yield* ImpactSnapshots;",
      },
      {
        path: "packages/domain/src/impact/lattice.ts",
        text: "const ImpactSourcesList = [];",
      },
    ];

    assert.deepStrictEqual(Arr.sort(unlisted(sources), Order.String), [
      "apps/web/src/functions/panel.functions.ts names releasedCount",
      "apps/web/src/server/panelReads.ts names ImpactSnapshots",
    ]);
  });

  it("control: an allowance whose file no longer names the guarded word is reported", () => {
    assert.isAbove(
      stale([
        {
          path: "packages/domain/src/impact/release.ts",
          text: "export const release = () => undefined;",
        },
      ]).length,
      0
    );
  });

  it.effect(
    "the real tree: every file that names a raw-count exit is listed, and every allowance is used",
    () =>
      Effect.gen(function* realTree() {
        const sources = yield* workingTreeSources(root, isSource);

        assert.isAbove(sources.length, 100);
        assert.deepStrictEqual(unlisted(sources), []);
        assert.deepStrictEqual(stale(sources), []);
      })
  );
});
