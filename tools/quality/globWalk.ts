import {
  Array as Arr,
  Effect,
  FileSystem,
  Option,
  String as Str,
} from "effect";

import type { Glob } from "./globImports.ts";

/** What one entry of a directory of the walk says about the glob: the reason it is not placed, or whether the walk goes into it. */
const examine = (
  root: string,
  entry: string,
  name: string,
  { deep, extensions }: Glob
) =>
  Effect.gen(function* examineEntry() {
    const fs = yield* FileSystem.FileSystem;

    // Only what the glob can load: every entry under `**`, otherwise the files of the last segment.
    const reached =
      deep ||
      Arr.some(extensions, (extension) => Str.endsWith(`.${extension}`)(name));

    if (!reached) {
      return { descend: false, reason: Option.none<string>() };
    }

    if (deep && name === "node_modules") {
      return {
        descend: false,
        reason: Option.some(`a wildcard reaches node_modules (${entry})`),
      };
    }

    const info = yield* Effect.option(fs.lstat(`${root}/${entry}`));

    return Option.exists(info, ({ type }) => type === "SymbolicLink")
      ? {
          descend: false,
          reason: Option.some(
            `a symbolic link (${entry}) is under a wildcard: Vite follows it to another package`
          ),
        }
      : {
          descend:
            deep && Option.exists(info, ({ type }) => type === "Directory"),
          reason: Option.none<string>(),
        };
  });

/** The directories to visit after this one, or the reason to stop. `left` is what remains of the bound, in entries. */
const visit = (
  root: string,
  directory: string,
  glob: Glob,
  left: { count: number },
  limit: number
) =>
  Effect.gen(function* visitDirectory() {
    const fs = yield* FileSystem.FileSystem;
    const further: string[] = [];

    const names = Option.getOrElse(
      yield* Effect.option(fs.readDirectory(`${root}/${directory}`)),
      (): string[] => []
    );

    for (const name of names) {
      // Every entry that is read counts, whether the glob matches it or not.
      left.count -= 1;

      if (left.count < 0) {
        return {
          further,
          reason: Option.some(
            `it reads more than ${limit} directory entries (the walk of the disk is bounded)`
          ),
        };
      }

      const entry = directory === "" ? name : `${directory}/${name}`;
      const seen = yield* examine(root, entry, name, glob);

      if (Option.isSome(seen.reason)) {
        return { further, reason: seen.reason };
      }

      if (seen.descend) {
        further.push(entry);
      }
    }

    return { further, reason: Option.none<string>() };
  });

/**
 * Walks what the glob can reach from `directory` (from the repository root `root`, real), never following a symbolic
 * link, and says why the glob is not placed: an entry that it can load is a symbolic link or, under `**`, `node_modules`,
 * or the walk reads more than `limit` directory entries (matched or not). None when nothing of the kind is there.
 */
export const wildcardRefusal = (
  root: string,
  directory: string,
  glob: Glob,
  limit: number
) =>
  Effect.gen(function* walkWildcards() {
    const left = { count: limit };
    const pending = [directory];

    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const step = yield* visit(root, next, glob, left, limit);

      if (Option.isSome(step.reason)) {
        return step.reason;
      }

      pending.push(...step.further);
    }

    return Option.none<string>();
  });
