import { Array as Arr, Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The files of the working tree at `root` that `keep` accepts (a path relative to `root`): the files that git tracks and
 * the untracked ones that no `.gitignore` excludes. A build output (`.alchemy/`, `.wrangler/`, `dist/`, `node_modules/`)
 * is ignored by the repository's own rules and so is not listed, whatever it holds. `git ls-files -c` also lists a
 * tracked file that is gone from the disk (a rename in progress, a probe file that another test removed); only files
 * present on disk are returned.
 */
export const workingTreePaths = Effect.fn("workingTreePaths")(
  function* workingTreePaths(root: string, keep: (path: string) => boolean) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
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

    return Arr.flatten(
      yield* Effect.forEach(
        Arr.filter(
          listing.split(/\r?\n/u),
          (file) => file !== "" && keep(file)
        ),
        (file) =>
          Effect.map(
            fs.exists(path.join(root, file)),
            (exists): readonly string[] => (exists ? [file] : [])
          )
      )
    );
  }
);
