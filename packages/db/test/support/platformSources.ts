/**
 * The files whose SQL must stay inside the subset that Hyperdrive takes (spec 0025, decision D6): the adapter's own
 * sources, the Worker's server sources (`apps/web/src`, but not the generated route tree) and the migrations.
 * Tests are not read: they use `SET LOCAL` and other session constructs on purpose, each ending with its own transaction.
 * The adapter's `src/platform/constructs.ts` is not read either: it is the declaration of the forbidden constructs, and names each.
 */
import { Array as Arr, Effect, FileSystem, Path } from "effect";

export interface Source {
  /** From the repository root. */
  readonly path: string;
  readonly source: string;
}

/** Needs `FileSystem` and `Path` (a test provides `NodeServices.layer`). */
export const sourcesOfTheAdapter = Effect.gen(function* sourcesOfTheAdapter() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(import.meta.dirname, "..", "..", "..", "..");

  const under = (directory: string, extensions: readonly string[]) =>
    Effect.map(
      fs.readDirectory(path.join(root, directory), { recursive: true }),
      (names) =>
        Arr.map(
          Arr.filter(
            names,
            (name) =>
              Arr.some(extensions, (extension) => name.endsWith(extension)) &&
              path.basename(name) !== "routeTree.gen.ts" &&
              // `src/platform/constructs.ts` is the declaration of what is forbidden: it names every construct in prose.
              name !== path.join("platform", "constructs.ts")
          ),
          (name) => path.join(directory, name)
        )
    );

  const files = Arr.flatten([
    yield* under("packages/db/src", [".ts"]),
    yield* under("apps/web/src", [".ts", ".tsx"]),
    yield* under("packages/db/drizzle", [".sql"]),
  ]);

  return yield* Effect.forEach(files, (file) =>
    Effect.map(fs.readFileString(path.join(root, file)), (source): Source => ({
      path: file,
      source,
    }))
  );
});
