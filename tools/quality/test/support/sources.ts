import { NodeServices } from "@effect/platform-node";
import { assert } from "@effect/vitest";
import { Array as Arr, Effect, FileSystem } from "effect";

import { isProbe } from "../../probes.ts";
import { workingTreePaths } from "../../workingTree.ts";

export interface Source {
  /** Relative to the directory that was read. */
  readonly path: string;
  readonly text: string;
}

/** Every file below `directory` that `keep` accepts, with its text. The scans of the source tree read through this. */
const readSources = (directory: string, keep: (path: string) => boolean) =>
  Effect.gen(function* readEachSource() {
    const fs = yield* FileSystem.FileSystem;

    const paths = Arr.filter(
      yield* fs.readDirectory(directory, { recursive: true }),
      keep
    );

    return yield* Effect.forEach(paths, (path) =>
      Effect.map(fs.readFileString(`${directory}/${path}`), (text): Source => ({
        path,
        text,
      }))
    );
  }).pipe(Effect.provide(NodeServices.layer));

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

/**
 * The TypeScript of `packages/domain/src`. `storeBoundary.test.ts` writes a probe file there for a moment, and the scans
 * run beside it, so a probe is not part of the source.
 */
export const domainSources = readSources(
  new URL("../../../../packages/domain/src", import.meta.url).pathname,
  (path) => path.endsWith(".ts") && !isProbe(`packages/domain/src/${path}`)
);
