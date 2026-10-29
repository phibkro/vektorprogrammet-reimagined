import { Effect, FileSystem, Path, Record as Rec } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { gitIn } from "../../workingTree.ts";

/**
 * A git repository in a temporary directory, removed when the scope closes: `files` (path from the root, text) are
 * written and not committed, and each of `links` (path, target relative to the repository root) is a symbolic link. The
 * scans read a repository through `git ls-files`, so a test that needs files on disk, the resolver's own files among
 * them, writes them here and not into the live tree, where the other test files of this package read at the same time.
 */
export const tempRepo = Effect.fn("tempRepo")(function* tempRepo(
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>> = {}
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const root = yield* fs.makeTempDirectoryScoped({ prefix: "module-graph-" });

  yield* spawner.string(gitIn(root, ["init", "--quiet"]));

  yield* Effect.forEach(
    Rec.toEntries(files),
    ([file, text]) =>
      Effect.andThen(
        fs.makeDirectory(path.dirname(path.join(root, file)), {
          recursive: true,
        }),
        fs.writeFileString(path.join(root, file), text)
      ),
    { discard: true }
  );

  yield* Effect.forEach(
    Rec.toEntries(links),
    ([link, target]) =>
      Effect.andThen(
        fs.makeDirectory(path.dirname(path.join(root, link)), {
          recursive: true,
        }),
        fs.symlink(path.join(root, target), path.join(root, link))
      ),
    { discard: true }
  );

  return root;
});
