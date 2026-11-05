import { NodeServices } from "@effect/platform-node";
import { assert } from "@effect/vitest";
import { Array as Arr, Effect, FileSystem, Record as Rec } from "effect";

import { workingTreePaths } from "../../workingTree.ts";

export interface Source {
  /** Relative to the directory that was read. */
  readonly path: string;
  readonly text: string;
}

/**
 * The files of the working tree at `root` that `keep` accepts (a path relative to `root`), with their text: what
 * `workingTreePaths` lists (tracked files and untracked ones that no `.gitignore` excludes), as `check:exceptions` and
 * `check:store-boundary` list them.
 */
export const workingTreeSources = (
  root: string,
  keep: (path: string) => boolean
) =>
  Effect.gen(function* readWorkingTree() {
    const fs = yield* FileSystem.FileSystem;

    return yield* Effect.forEach(yield* workingTreePaths(root, keep), (path) =>
      Effect.map(fs.readFileString(`${root}/${path}`), (text): Source => ({
        path,
        text,
      }))
    );
  }).pipe(Effect.provide(NodeServices.layer));

/** The root of the repository, without a trailing slash: where the scans of the real tree start. */
export const repositoryRoot = new URL(
  "../../../../",
  import.meta.url
).pathname.replace(/\/$/u, "");

/** All authored TypeScript source of the web application, including adapters and UI. */
export const isWebSource = (path: string): boolean =>
  /^apps\/web\/src\/.*\.tsx?$/u.test(path);

/**
 * The assertion of a source scan over the real tree: it reads more than a hundred files, and no file is reported as
 * naming a guarded thing without being listed (`unlisted`), and no listing is left that no file needs (`stale`).
 */
export const assertCleanScan = (
  root: string,
  keep: (path: string) => boolean,
  findings: {
    readonly stale: (sources: readonly Source[]) => readonly string[];
    readonly unlisted: (sources: readonly Source[]) => readonly string[];
  }
) =>
  Effect.map(workingTreeSources(root, keep), (sources) => {
    assert.isAbove(sources.length, 100);
    assert.deepStrictEqual(findings.unlisted(sources), []);
    assert.deepStrictEqual(findings.stale(sources), []);
  });

/** One thing that a scan guards: the pattern that finds it, and the files that may have it, each with why. */
export interface Sign {
  readonly allowed: Readonly<Record<string, string>>;
  readonly pattern: RegExp;
}

/**
 * The two findings of a scan over named signs: `unlisted` (`file has Sign` for each file that has a sign and is not
 * allowed to) and `stale` (`file is allowed Sign` for each allowance whose file does not have the sign), so that the
 * list of allowances can only shrink.
 */
export const signFindings = (signs: Readonly<Record<string, Sign>>) => ({
  stale: (sources: readonly Source[]): readonly string[] =>
    Arr.flatMap(Rec.toEntries(signs), ([name, sign]) =>
      Arr.flatMap(Rec.keys(sign.allowed), (path) =>
        Arr.some(
          sources,
          (source) => source.path === path && sign.pattern.test(source.text)
        )
          ? []
          : [`${path} is allowed ${name} and does not have it`]
      )
    ),
  unlisted: (sources: readonly Source[]): readonly string[] =>
    Arr.flatMap(sources, ({ path, text }) =>
      Arr.flatMap(Rec.toEntries(signs), ([name, sign]) =>
        sign.pattern.test(text) && sign.allowed[path] === undefined
          ? [`${path} has ${name}`]
          : []
      )
    ),
});

/** Domain code lives in the shared domain and in feature-owned domain directories. */
export const domainSources = workingTreeSources(repositoryRoot, (path) =>
  /^apps\/web\/src\/(?:domain\/|features\/[^/]+\/domain\/).*\.ts$/u.test(path)
);
