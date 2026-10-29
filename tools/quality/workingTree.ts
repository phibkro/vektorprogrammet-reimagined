import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { isProbe } from "./probes.ts";

/**
 * The variables that tie git to one repository, as `git rev-parse --local-env-vars` prints them (git 2.55). A git hook
 * runs with some of them set (a worktree's pre-push has `GIT_DIR` pointing at `.git/worktrees/<name>`), and they win
 * over `-C`: under them `git -C <temporary directory> init` re-initialised the repository's own shared config and set
 * `core.bare = true`, so the main checkout stopped being a working tree. Every git command here runs with them unset
 * (an `undefined` value drops an inherited variable).
 */
const withoutRepository = {
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_CONFIG: undefined,
  GIT_CONFIG_COUNT: undefined,
  GIT_CONFIG_PARAMETERS: undefined,
  GIT_DIR: undefined,
  GIT_GRAFT_FILE: undefined,
  GIT_IMPLICIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_NO_REPLACE_OBJECTS: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_PREFIX: undefined,
  GIT_REPLACE_REF_BASE: undefined,
  GIT_SHALLOW_FILE: undefined,
  GIT_WORK_TREE: undefined,
};

/** `git -C root …args`, run against `root` alone, whatever repository the calling process (a hook) was started in. */
export const gitIn = (root: string, args: readonly string[]) =>
  ChildProcess.make("git", ["-C", root, ...args], {
    env: withoutRepository,
    extendEnv: true,
  });

/**
 * The files of the working tree at `root` that `keep` accepts (a path relative to `root`): the files that git tracks and
 * the untracked ones that no `.gitignore` excludes. A build output (`.alchemy/`, `.wrangler/`, `dist/`, `node_modules/`)
 * is ignored by the repository's own rules and so is not listed, whatever it holds. `git ls-files -c` also lists a
 * tracked file that is gone from the disk (a rename in progress, a probe file that another test removed); only files
 * present on disk are returned. A probe (`probes.ts`: a scratch file that a test of this package writes for one lint
 * run) is never listed, so no scan of the tree can see one that a test running beside it has written.
 */
export const workingTreePaths = Effect.fn("workingTreePaths")(
  function* workingTreePaths(root: string, keep: (path: string) => boolean) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const listing = yield* spawner.string(
      gitIn(root, ["ls-files", "-c", "-o", "--exclude-standard"])
    );

    return Arr.flatten(
      yield* Effect.forEach(
        Arr.filter(
          Str.split(listing, /\r?\n/u),
          (file) => file !== "" && !isProbe(file) && keep(file)
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
