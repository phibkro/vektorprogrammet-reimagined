import { Array as Arr, Effect, FileSystem, Option } from "effect";

import { globToRegExp } from "./storeBoundary.ts";

/** One directory of the walk, and the index of the wildcard segment that its entries are matched against. */
interface Visit {
  readonly directory: string;
  readonly index: number;
}

/** How many entries the walk may still list, shared by every glob of one pattern. */
export interface Budget {
  left: number;
}

/** The entries of `directory` (from the repository root `root`) that the wildcard segment `segment` can match. */
const matching = (root: string, directory: string, segment: string) =>
  Effect.gen(function* listMatching() {
    const fs = yield* FileSystem.FileSystem;

    const names = Option.getOrElse(
      yield* Effect.option(fs.readDirectory(`${root}/${directory}`)),
      (): string[] => []
    );

    return Arr.filter(names, (name) =>
      segment === "**" || !segment.includes("*")
        ? segment === "**" || name === segment
        : globToRegExp(segment).test(name)
    );
  });

/** What one entry says about the glob: the reason it is not placed, or whether the walk goes into it. */
const inspect = (root: string, entry: string, name: string) =>
  Effect.gen(function* inspectEntry() {
    const fs = yield* FileSystem.FileSystem;

    if (name === "node_modules") {
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
          descend: Option.exists(info, ({ type }) => type === "Directory"),
          reason: Option.none<string>(),
        };
  });

/** An entry of the walk: why the glob is not placed, or whether the walk goes into it; the budget is spent here. */
const examine = (
  root: string,
  entry: string,
  name: string,
  budget: Budget,
  limit: number
) =>
  Effect.gen(function* examineEntry() {
    budget.left -= 1;

    if (budget.left < 0) {
      return {
        descend: false,
        reason: Option.some(
          `its wildcards reach more than ${limit} entries (the walk of the disk is bounded)`
        ),
      };
    }

    return yield* inspect(root, entry, name);
  });

/** One directory of the walk: the reason to stop, or the directories to visit next. */
const visitOnce = (
  root: string,
  next: Visit,
  segment: string,
  budget: Budget,
  limit: number
) =>
  Effect.gen(function* visitDirectory() {
    const further: Visit[] = [];

    for (const name of yield* matching(root, next.directory, segment)) {
      const entry = next.directory === "" ? name : `${next.directory}/${name}`;
      const seen = yield* examine(root, entry, name, budget, limit);

      if (Option.isSome(seen.reason)) {
        return { further, reason: seen.reason };
      }

      if (seen.descend) {
        // `**` reaches every directory below, whatever the segments after it say.
        further.push({
          directory: entry,
          index: segment === "**" ? next.index : next.index + 1,
        });
      }
    }

    return { further, reason: Option.none<string>() };
  });

/**
 * Walks the tree that the wildcard `segments` can reach from the directory `start` (from the repository root `root`,
 * after symbolic links) without following a link, and says why the glob is not placed: an entry that a wildcard matches
 * is `node_modules` or a symbolic link, or the walk lists more than `limit` entries (`budget` is what is left of them).
 * None when nothing of the kind is there.
 */
export const wildcardRefusal = (
  root: string,
  start: string,
  segments: readonly string[],
  budget: Budget,
  limit: number
) =>
  Effect.gen(function* walkWildcards() {
    const pending: Visit[] = [{ directory: start, index: 0 }];

    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const segment = segments[next.index];

      if (segment !== undefined) {
        const step = yield* visitOnce(root, next, segment, budget, limit);

        if (Option.isSome(step.reason)) {
          return step.reason;
        }

        pending.push(...step.further);
      }
    }

    return Option.none<string>();
  });
