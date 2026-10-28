/**
 * Spec 0020, review rounds 1 and 2: what the check does with an import once the resolver has placed it, and the other
 * ways past it that the reviewers found. Each case that needs files on disk (the resolver reads them) runs in a git
 * repository in a temporary directory, scanned as the real one is, so no test here writes into the working tree that the
 * other test files of this package read at the same time.
 */
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect } from "effect";

import { importSpecifiers } from "../importSpecifiers.ts";
import type { Declaration } from "../moduleGraph.ts";
import { moduleGraphFindings, scanImports } from "../moduleGraphCheck.ts";
import { isProbe, moduleGraphProbes } from "../probes.ts";
import type { SourceFile } from "../resolveImports.ts";
import {
  check,
  clean,
  d,
  fixture,
  importing,
  mentioning,
  own,
  replacing,
  source,
} from "./support/moduleGraphFixture.ts";
import { tempRepo } from "./support/tempRepo.ts";

const ids = `${d}/vocab/ids.ts`;
const kernel = `${d}/kernel/a.ts`;

/**
 * The findings of a repository that holds `files` (and the symbolic `links`), scanned and checked as the real one is. The
 * declared edges that the files of one case do not use are not that case's business, so the findings about them are left out.
 */
const findingsOf = (
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>> = {}
) =>
  Effect.gen(function* inTempRepo() {
    const repo = yield* tempRepo(files, links);
    const found = moduleGraphFindings(fixture, yield* scanImports(repo));

    return Arr.filter(
      found,
      (finding) =>
        !finding.includes(", but no file of ") &&
        !finding.includes(", which matches no file")
    );
  }).pipe(Effect.provide(NodeServices.layer));

const upward = (line: number, target: string, path = kernel) =>
  `${path}:${line}: imports ${target} (module team, service), an upward import from module kernel (library)`;

const base = {
  [ids]: "export const id = 1;\n",
  [kernel]: 'import "../vocab/ids.ts";\n',
  [`${d}/team/a.ts`]: 'import "../vocab/ids.ts";\n',
};

const notTs = (path: string) =>
  `${path}: is a source file of the governed tree (${fixture.governed}) and not a .ts file; the module globs read .ts only, so rename it`;

describe("module graph: resolution and the ways past the check (spec 0020, review rounds)", () => {
  it.effect(
    "R4 (round 2): `.js` and `.mjs` specifiers, no extension and `/index` name the source file beside them, so an upward import written so is found",
    () =>
      Effect.gen(function* resolvesAsTypeScriptDoes() {
        for (const [specifier, target] of [
          ["../team/a.js", `${d}/team/a.ts`],
          ["../team/a.ts", `${d}/team/a.ts`],
          ["../team/a", `${d}/team/a.ts`],
          ["../team", `${d}/team/index.ts`],
        ] as const) {
          assert.deepStrictEqual(
            mentioning(
              yield* findingsOf({
                ...base,
                [`${d}/team/index.ts`]: "export {};\n",
                [kernel]: `import "${specifier}";\n`,
              }),
              kernel
            ),
            [upward(1, target)],
            specifier
          );
        }

        // `.mjs` names the `.mts` file; a `.mts` file in the governed tree is itself a finding.
        assert.deepStrictEqual(
          mentioning(
            yield* findingsOf({
              ...base,
              [`${d}/team/b.mts`]: "export {};\n",
              [kernel]: 'import "../team/b.mjs";\n',
            }),
            "b.m"
          ),
          [notTs(`${d}/team/b.mts`)]
        );
      }),
    120_000
  );

  it.effect(
    "R4 (round 2): a declaration file, JSON, an asset and a `?raw` query resolve; an import of a file that is not there fails closed",
    () =>
      Effect.gen(function* failsClosed() {
        // Control: every one of these exists, so none is a finding.
        assert.deepStrictEqual(
          yield* findingsOf({
            ...base,
            [`${d}/vocab/README.md`]: "# x\n",
            [`${d}/vocab/logo.svg`]: "<svg/>\n",
            [`${d}/vocab/seed.json`]: "{}\n",
            [`${d}/vocab/types.d.ts`]: "export type Id = number;\n",
            [ids]: Arr.join(
              [
                'import type {} from "./types";',
                'import type {} from "./types.js";',
                'import "./seed.json";',
                'import "./logo.svg";',
                'import "./README.md?raw";',
                "",
              ],
              "\n"
            ),
          }),
          []
        );

        const gone = (line: number, specifier: string) =>
          `${ids}:${line}: imports ${specifier}, which resolves to no source file (the check fails closed: an import it cannot place is not one it can approve)`;

        assert.deepStrictEqual(
          yield* findingsOf({
            ...base,
            [ids]: 'import "./missing.ts";\nimport "./missing.json";\n',
          }),
          [gone(1, "./missing.ts"), gone(2, "./missing.json")]
        );
      }),
    120_000
  );

  it.effect(
    "R1 (round 2): a governed file cannot launder an upward import through a source file that no module owns",
    () =>
      Effect.gen(function* noLaundering() {
        for (const [through, relative, reexport] of [
          [
            "packages/domain/lib/bridge.ts",
            "../../lib/bridge.ts",
            "../src/team/a.ts",
          ],
          [
            "packages/domain/test/support/bridge.ts",
            "../../test/support/bridge.ts",
            "../../src/team/a.ts",
          ],
        ] as const) {
          assert.deepStrictEqual(
            mentioning(
              yield* findingsOf({
                ...base,
                [ids]: `import "${relative}";\n`,
                [through]: `export * from "${reexport}";\n`,
              }),
              `${ids}:1:`
            ),
            [
              `${ids}:1: imports ${through}, a source file of its own package that no module owns (${fixture.governed}): its imports are beyond every module rule, so the governed tree may not import it`,
            ],
            through
          );
        }

        // Control: a data file of the package is not unowned source, and the files of the governed tree are the module rules' own.
        assert.deepStrictEqual(
          mentioning(
            yield* findingsOf({
              ...base,
              [`${d}/vocab/seed.json`]: "{}\n",
              [ids]: 'import "./seed.json";\n',
            }),
            `${ids}:1:`
          ),
          []
        );
      }),
    120_000
  );

  it('R2 (round 2): a type-level `import("…")` is a specifier', () => {
    assert.deepStrictEqual(
      importSpecifiers(
        "types.ts",
        Arr.join(
          [
            'export type A = typeof import("../organisation/commands.ts");',
            'export type B = import("./y.ts").Foo;',
            "export type C = import(someVariable).Foo;",
            'export type D = import("./y.ts", { with: { "resolution-mode": "import" } }).Foo;',
          ],
          "\n"
        )
      ),
      [
        { line: 1, specifier: "../organisation/commands.ts" },
        { line: 2, specifier: "./y.ts" },
        { line: 4, specifier: "./y.ts" },
      ]
    );
  });

  it.effect(
    "R2 (round 2): an upward `typeof import(…)` is found through the scan, as the same import written `export type … from` is",
    () =>
      Effect.gen(function* typeLevelEdge() {
        for (const line of [
          'export type Probe = typeof import("../team/a.ts");',
          'export type { Probe } from "../team/a.ts";',
        ]) {
          assert.deepStrictEqual(
            mentioning(
              yield* findingsOf({ ...base, [kernel]: `${line}\n` }),
              kernel
            ),
            [upward(1, `${d}/team/a.ts`)],
            line
          );
        }
      }),
    120_000
  );

  it.effect(
    "R3 (round 2): an alias resolves through the unit's tsconfig and package.json, so one with `..` that leaves the unit is found",
    () =>
      Effect.gen(function* aliases() {
        const unit = {
          "apps/cms/src/live.config.ts": "export const live = 1;\n",
          "apps/web/package.json":
            '{ "name": "@vektorprogrammet/web", "imports": { "#/*": "./src/*" } }\n',
          "apps/web/src/lib/x.ts": "export const x = 1;\n",
          "apps/web/tsconfig.json":
            '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }\n',
          "packages/cms-client/src/a.ts": "export const a = 1;\n",
        };

        // Control: an alias that stays inside the unit is no finding.
        assert.deepStrictEqual(
          yield* findingsOf({
            ...unit,
            "apps/web/src/a.ts": 'import "@/lib/x";\nimport "#/lib/x";\n',
          }),
          []
        );

        // An alias with `..` that leaves the unit is the relative path that it spells.
        assert.deepStrictEqual(
          yield* findingsOf({
            ...unit,
            "apps/web/src/a.ts":
              'import type {} from "@/../../cms/src/live.config.ts";\nimport type {} from "@/../../../packages/cms-client/src/a.ts";\n',
          }),
          [
            "apps/web/src/a.ts:1: apps/web reaches into apps/cms by the path @/../../cms/src/live.config.ts; import the package by its name",
            "apps/web/src/a.ts:2: apps/web reaches into packages/cms-client by the path @/../../../packages/cms-client/src/a.ts; import the package by its name",
          ]
        );

        // An alias that names no file fails closed, as a relative path does.
        assert.deepStrictEqual(
          yield* findingsOf({
            ...unit,
            "apps/web/src/a.ts": 'import "@/lib/nothing";\n',
          }),
          [
            "apps/web/src/a.ts:1: imports @/lib/nothing, which resolves to no source file (the check fails closed: an import it cannot place is not one it can approve)",
          ]
        );
      }),
    120_000
  );

  it.effect(
    "R5 (round 2): a symbolic link in the governed tree is a finding, and an import through it names the real file's module",
    () =>
      Effect.gen(function* symlinks() {
        const link = `${d}/kernel/bridge.ts`;
        const use = `${d}/kernel/use.ts`;

        const found = yield* findingsOf(
          { ...base, [use]: 'export * from "./bridge.ts";\n' },
          { [link]: `${d}/team/a.ts` }
        );

        assert.deepStrictEqual(mentioning(found, link), [
          `${link}: is a symbolic link in the governed tree (${fixture.governed}); the module rules read real paths, so a link would hide an edge: import the real file, or move it`,
        ]);

        // The import through the link is the import of the file behind it: `kernel` uses `team`'s file.
        assert.deepStrictEqual(mentioning(found, use), [
          upward(1, `${d}/team/a.ts`, use),
        ]);

        // Control: the same file as a plain file has no such finding.
        assert.deepStrictEqual(
          mentioning(
            yield* findingsOf({
              ...base,
              [link]: 'import "../vocab/ids.ts";\n',
            }),
            "bridge.ts"
          ),
          []
        );
      }),
    120_000
  );

  it.effect(
    "R4 (round 4 of the list): a probe path is invisible to the scan, and a file with a similar name is read like any other",
    () =>
      Effect.gen(function* probeIsInvisible() {
        const similar = `${d}/kernel/moduleGraphProbeHelper.ts`;

        assert.isTrue(isProbe(moduleGraphProbes.flatA));
        assert.isFalse(isProbe(similar));

        // A probe path holds a restricted import and the scan does not read it.
        assert.deepStrictEqual(
          mentioning(
            yield* findingsOf({
              ...base,
              [moduleGraphProbes.flatA]: 'import "node:fs";\n',
            }),
            "moduleGraphProbe"
          ),
          []
        );

        // The same imports in a committed file with a similar name are findings.
        assert.deepStrictEqual(
          mentioning(
            yield* findingsOf({
              ...base,
              [similar]: 'import "node:fs";\nimport "../team/a.ts";\n',
            }),
            similar
          ),
          [
            `${similar}:1: module kernel imports node:fs, and a module imports only effect`,
            upward(2, `${d}/team/a.ts`, similar),
          ]
        );
      }),
    120_000
  );

  it("R4 (round 1): a file that imports its own package by name is flagged, and an import of another declared unit is not", () => {
    assert.deepStrictEqual(
      check(importing("apps/web/src/server/a.ts", "@vektorprogrammet/web")),
      [own("apps/web", "web", 3, "apps/web/src/server/a.ts")]
    );

    assert.deepStrictEqual(check(importing(ids, "@vektorprogrammet/domain")), [
      own("packages/domain", "domain", 2, ids),
    ]);

    // Control: `apps/web` imports `@vektorprogrammet/domain`, which it declares (`clean` holds it).
    assert.deepStrictEqual(check(clean), []);
  });

  it("R5 (round 1): a source file in the governed tree that is not `.ts` fails, whatever its extension", () => {
    for (const extension of [".mts", ".cts", ".tsx", ".js"]) {
      const path = `${d}/team/x${extension}`;

      assert.deepStrictEqual(
        mentioning(
          check(replacing(source(path, "sanitize-html", "../kernel/a.ts"))),
          path
        ),
        [notTs(path)]
      );
    }

    // Control: the same file as `.ts` is a member of its module, and its imports are checked.
    assert.deepStrictEqual(
      check(replacing(source(`${d}/team/x.ts`, "../vocab/ids.ts"))),
      []
    );
  });

  it("R9 (round 2): a tolerated integration call is keyed to the call itself: the entry holds while the call is inside the transaction and fails when it leaves, or when only the name stays", () => {
    const call = {
      call: "sender.send",
      file: "apps/web/src/server/delivery.ts",
      reason: "mails inside the transaction",
      retirementTrigger: "delivery restructured",
      within: "transactor.run",
    };

    const tolerated: Declaration = { ...fixture, integrationCalls: [call] };

    const delivery = (text: string): SourceFile => ({
      imports: [],
      path: call.file,
      symlink: false,
      text,
    });

    const stale = [
      `integration call: ${call.file} no longer has sender.send(…) inside transactor.run(…) (delivery restructured); remove the entry from integrationCalls`,
    ];

    // Control: the call is inside the transaction.
    assert.deepStrictEqual(
      check(
        [
          ...clean,
          delivery(
            "const issueCode = () => transactor.run(Effect.gen(function* () { yield* sender.send(email, key); }));"
          ),
        ],
        tolerated
      ),
      []
    );

    // The restructure: the mail is sent after the commit. The method name and the call stay; the entry is stale.
    assert.deepStrictEqual(
      check(
        [
          ...clean,
          delivery(
            "const issueCode = () => transactor.run(commit).pipe(Effect.andThen(sender.send(email, key)));"
          ),
        ],
        tolerated
      ),
      stale
    );

    // A comment that names the call does not keep it alive, and neither does a file that has gone.
    assert.deepStrictEqual(
      check(
        [
          ...clean,
          delivery("// transactor.run(sender.send(a))\nconst issueCode = 1;"),
        ],
        tolerated
      ),
      stale
    );

    assert.deepStrictEqual(check(clean, tolerated), stale);
  });
});
