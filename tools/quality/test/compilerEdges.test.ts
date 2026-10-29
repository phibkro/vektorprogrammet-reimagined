/**
 * Spec 0023 (spike): the import edges that `oxc-resolver` gives the module graph check, against the edges that the
 * TypeScript 7.1 compiler resolves for the same files of the real tree. A difference is reported as `path:line`.
 */
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  Duration,
  Effect,
  FileSystem,
  Path,
  Record as Rec,
  Schedule,
} from "effect";

import { compilerEdges, edgeDifferences } from "../compilerEdges.ts";
import { readSources } from "../resolveImports.ts";
import { workingTreePaths } from "../workingTree.ts";
import { tempRepo } from "./support/tempRepo.ts";

const root = new URL("../../../", import.meta.url).pathname;

/**
 * Each unit's tsconfig whose edges are compared, with the differences that are known and by design: a Vite query
 * (`?url`, `?raw`) is not part of the path for the check and makes the compiler's resolution fail.
 */
const units = {
  "apps/cms": [],
  "apps/web": [
    "apps/web/src/routes/__root.tsx:17 ../styles.css?url: the check: file apps/web/src/styles.css; the compiler: unresolved",
  ],
  "packages/cms-client": [],
  "packages/db": [],
  "packages/domain": [],
  "tools/db-path-spike": [],
  "tools/docgen": [],
  "tools/effx-conformance": [],
  "tools/import": [],
  "tools/quality": [],
} satisfies Record<string, readonly string[]>;

const isSource = (path: string): boolean => /\.[cm]?[jt]sx?$/u.test(path);

describe("module graph: oxc-resolver edges against the TypeScript 7.1 compiler's (spec 0023)", () => {
  for (const [unit, known] of Rec.toEntries(units)) {
    it.live(
      `${unit}: every import of every source file resolves to the same file or category`,
      () =>
        Effect.gen(function* edgesAgree() {
          const fs = yield* FileSystem.FileSystem;
          const real = yield* fs.realPath(root);

          const paths = Arr.filter(
            yield* workingTreePaths(real, isSource),
            (path) => path.startsWith(`${unit}/`)
          );

          const [oxcTime, ours] = yield* Effect.timed(readSources(real, paths));

          const [compilerTime, theirs] = yield* Effect.timed(
            Effect.scoped(compilerEdges(real, `${real}/${unit}/tsconfig.json`))
          );

          const inUnit = Arr.filter(theirs, ({ path }) =>
            path.startsWith(`${unit}/`)
          );

          yield* Effect.log(
            `${unit}: ${paths.length} files, ${inUnit.length} compiler edges, ${Arr.flatMap(ours, ({ imports }) => imports).length} oxc edges; oxc-resolver ${Duration.toMillis(oxcTime).toFixed(0)} ms, compiler ${Duration.toMillis(compilerTime).toFixed(0)} ms`
          );

          // Not vacuous: the files and the edges are read.
          assert.isAbove(paths.length, 3);
          assert.isAbove(inUnit.length, 10);

          assert.deepStrictEqual(edgeDifferences(ours, inUnit), known);
        }).pipe(Effect.provide(NodeServices.layer)),
      120_000
    );
  }

  it.live(
    "a repository of the forms that the real tree does not use: what the two resolvers say of each",
    () =>
      Effect.gen(function* exoticForms() {
        const fs = yield* FileSystem.FileSystem;

        const repo = yield* fs.realPath(
          yield* tempRepo(
            {
              "package.json":
                '{ "name": "fixture", "type": "module", "imports": { "#internal": "./src/internal.ts" } }',
              "src/a.ts": Arr.join(
                [
                  'import "./b.js";',
                  'import "./dir";',
                  'import "./dir/index.ts";',
                  'import "./data.json";',
                  'import "@/b.ts";',
                  'import "#internal";',
                  'import "./linked.ts";',
                  'import "./missing.ts";',
                  'export * from "./b.ts";',
                  'export type T = typeof import("./b.ts");',
                  'import c = require("./c.cts");',
                  'import "node:fs";',
                  "",
                ],
                "\n"
              ),
              "src/b.ts": "export const b = 1;\n",
              "src/c.cts": "export = 1;\n",
              "src/data.json": "{}\n",
              "src/dir/index.ts": "export const d = 1;\n",
              "src/internal.ts": "export const i = 1;\n",
              "tsconfig.json":
                '{ "compilerOptions": { "allowImportingTsExtensions": true, "baseUrl": ".", "module": "nodenext", "moduleResolution": "nodenext", "noEmit": true, "paths": { "@/*": ["./src/*"] }, "skipLibCheck": true, "types": [] }, "include": ["src"] }',
            },
            { "src/linked.ts": "src/b.ts" }
          )
        );

        const ours = yield* readSources(repo, [
          "src/a.ts",
          "src/b.ts",
          "src/c.cts",
          "src/dir/index.ts",
          "src/internal.ts",
        ]);

        const theirs = yield* Effect.scoped(
          compilerEdges(repo, `${repo}/tsconfig.json`)
        );

        // Two real differences, both by design of the check: it follows a directory import with no extension
        // (`nodenext` in an ES module package refuses it: the compiler's answer is unresolved) and a symbolic link to
        // the real file (the compiler keeps the link's own path for a relative import).
        assert.deepStrictEqual(edgeDifferences(ours, theirs), [
          "src/a.ts:2 ./dir: the check: file src/dir/index.ts; the compiler: unresolved",
          "src/a.ts:7 ./linked.ts: the check: file src/b.ts; the compiler: file src/linked.ts",
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
    120_000
  );

  it.live(
    "the compiler process lives as long as the scope that asked for the edges, and not longer",
    () =>
      Effect.gen(function* childIsOwned() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const real = yield* fs.realPath(root);
        const tasks = `/proc/${process.pid}/task`;

        /** The processes that this process has started and that still run (Linux `children` files, one per thread). */
        const children = Effect.gen(function* started() {
          const lists = yield* Effect.forEach(
            yield* fs.readDirectory(tasks),
            (task) => fs.readFileString(path.join(tasks, task, "children"))
          );

          return Arr.flatMap(lists, (list) =>
            Arr.filter(list.split(" "), (pid) => pid !== "")
          );
        });

        const before = yield* children;

        const during = yield* Effect.scoped(
          Effect.andThen(
            compilerEdges(real, `${real}/tools/docgen/tsconfig.json`),
            children
          )
        );

        assert.isAbove(during.length, before.length);

        // The scope has closed: the compiler process is gone (it may take a moment to be reaped).
        yield* Effect.retry(
          Effect.flatMap(children, (after) =>
            after.length === before.length
              ? Effect.void
              : Effect.fail("the compiler process still runs")
          ),
          { schedule: Schedule.spaced("100 millis"), times: 50 }
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    120_000
  );

  it.live(
    "a difference is reported with its file and line (control: the comparison fails when one edge is changed)",
    () =>
      Effect.gen(function* differencesAreNamed() {
        const fs = yield* FileSystem.FileSystem;
        const real = yield* fs.realPath(root);
        const unit = "packages/domain";

        const paths = Arr.filter(
          yield* workingTreePaths(real, isSource),
          (path) => path.startsWith(`${unit}/`)
        );

        const ours = yield* readSources(real, paths);

        const theirs = Arr.filter(
          yield* Effect.scoped(
            compilerEdges(real, `${real}/${unit}/tsconfig.json`)
          ),
          ({ path }) => path.startsWith(`${unit}/`)
        );

        const [first, ...rest] = theirs;

        assert.isDefined(first);

        // The compiler reads one import differently, and another is missing from its list.
        const changed = [
          {
            ...first,
            target: { kind: "file" as const, path: `${unit}/src/nowhere.ts` },
          },
          ...rest.slice(1),
        ];

        const found = edgeDifferences(ours, changed);
        const [dropped] = rest;

        assert.isDefined(dropped);

        assert.lengthOf(found, 2);
        assert.isTrue(
          Arr.some(found, (line) =>
            line.startsWith(`${first.path}:${first.line} ${first.specifier}: `)
          )
        );
        assert.isTrue(
          Arr.some(found, (line) =>
            line.startsWith(
              `${dropped.path}:${dropped.line} ${dropped.specifier}: the compiler has no such import`
            )
          )
        );

        // Control: the unchanged list is the same.
        assert.deepStrictEqual(edgeDifferences(ours, theirs), []);
      }).pipe(Effect.provide(NodeServices.layer)),
    120_000
  );
});
