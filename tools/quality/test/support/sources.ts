import { NodeServices } from "@effect/platform-node";
import { Array as Arr, Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export interface Source {
  /** Relative to the directory that was read. */
  readonly path: string;
  readonly text: string;
}

/** Every file below `directory` that `keep` accepts, with its text. The scans of the source tree read through this. */
export const readSources = (
  directory: string,
  keep: (path: string) => boolean
) =>
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
 * The files of the working tree at `root` that `keep` accepts (a path relative to `root`), with their text: the files that
 * git tracks, and the untracked ones that no `.gitignore` excludes, as `check:exceptions` and `check:store-boundary`
 * list them. A build output (`.alchemy/`, `.wrangler/`, `dist/`, `node_modules/`) is ignored by the repository's own
 * rules and so is not read, whatever it holds. A file that git lists and that is gone from the disk (a rename in
 * progress, a probe file that another test removed) is skipped.
 */
export const workingTreeSources = (
  root: string,
  keep: (path: string) => boolean
) =>
  Effect.gen(function* readWorkingTree() {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const listing = yield* spawner.string(
      ChildProcess.make("git", [
        "-C",
        root,
        "ls-files",
        "-c",
        "-o",
        "--exclude-standard",
      ])
    );

    const listed = Arr.filter(
      listing.split(/\r?\n/u),
      (path) => path !== "" && keep(path)
    );

    const present = Arr.flatten(
      yield* Effect.forEach(listed, (path) =>
        Effect.map(fs.exists(`${root}/${path}`), (exists): readonly string[] =>
          exists ? [path] : []
        )
      )
    );

    return yield* Effect.forEach(present, (path) =>
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
  (path) => path.endsWith(".ts") && !path.includes("storeBoundaryProbe")
);
