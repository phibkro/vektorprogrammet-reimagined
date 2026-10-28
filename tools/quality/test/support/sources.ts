import { NodeServices } from "@effect/platform-node";
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

/**
 * The TypeScript of `packages/domain/src`. `storeBoundary.test.ts` writes a probe file there for a moment, and the scans
 * run beside it, so a probe is not part of the source.
 */
export const domainSources = readSources(
  new URL("../../../../packages/domain/src", import.meta.url).pathname,
  (path) => path.endsWith(".ts") && !isProbe(path)
);
