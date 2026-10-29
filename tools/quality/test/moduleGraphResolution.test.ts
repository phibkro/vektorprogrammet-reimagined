/**
 * Spec 0020, review rounds 1 and 2: what the check does with an import once the resolver has placed it, and the other
 * ways past it that the reviewers found. Each case that needs files on disk (the resolver reads them) runs in a git
 * repository in a temporary directory, scanned as the real one is, so no test here writes into the working tree that the
 * other test files of this package read at the same time.
 */
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, Record as Rec } from "effect";

import { importSpecifiers } from "../importSpecifiers.ts";
import type { Declaration } from "../moduleGraph.ts";
import { moduleGraphFindings, scanImports } from "../moduleGraphCheck.ts";
import { isProbe, moduleGraphProbes } from "../probes.ts";
import { readSources } from "../resolveImports.ts";
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

/** The findings about `apps/web/src/server/seeds.ts`, which holds `written`, in a repository of `files` and `links` (the web package has a `package.json`, so its Vite root is its directory). */
const scannedGlob = (
  written: string,
  files: Record<string, string> = {},
  links: Record<string, string> = {}
) =>
  findingsOf(
    {
      ...base,
      "apps/web/package.json": "{}\n",
      ...files,
      "apps/web/src/server/seeds.ts": written,
    },
    links
  ).pipe(
    Effect.map((found) => mentioning(found, "apps/web/src/server/seeds.ts"))
  );

/** `${name}`, the hole of a template literal, built so that no string of this file looks like a template. */
const hole = Arr.join(["$", "{name}"], "");

/** The two services that a file binds, under the names it gives them. */
const bound = (mail: string, run: string) =>
  `const ${run} = yield* Transactor;\nconst ${mail} = yield* MessageSender;\n`;

/** `body` as the generator of an Effect program, where `yield*` is a delegation and not a multiplication. */
const inGen = (body: string) =>
  `export const layer = Effect.gen(function* () {\n${body}\n});\n`;

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

  it("R9 (rounds 2 and 3): a tolerated integration call is keyed to the call itself, by the service its receiver is bound to: the entry holds while the call is inside the transaction and when a variable is renamed, and fails when the call leaves, when only the name stays, or when the name now belongs to another service", () => {
    const call = {
      call: { method: "send", service: "MessageSender" },
      file: "apps/web/src/server/delivery.ts",
      reason: "mails inside the transaction",
      retirementTrigger: "delivery restructured",
      within: { method: "run", service: "Transactor" },
    };

    const tolerated: Declaration = { ...fixture, integrationCalls: [call] };

    const delivery = (text: string): SourceFile => ({
      computed: [],
      imports: [],
      path: call.file,
      symlink: false,
      text,
    });

    const stale = [
      `integration call: ${call.file} no longer has MessageSender.send(…) inside Transactor.run(…) (delivery restructured); remove the entry from integrationCalls`,
    ];

    const inside = (mail: string, run: string) =>
      inGen(
        `${bound(mail, run)}const issueCode = () => ${run}.run(Effect.gen(function* () { yield* ${mail}.send(email, key); }));`
      );

    // Control: the call is inside the transaction.
    assert.deepStrictEqual(
      check([...clean, delivery(inside("sender", "transactor"))], tolerated),
      []
    );

    // Round 3: the variables are renamed, and the call is still inside the transaction: the entry holds.
    assert.deepStrictEqual(
      check([...clean, delivery(inside("mailer", "tx"))], tolerated),
      []
    );

    // The restructure: the mail is sent after the commit. The method name and the call stay; the entry is stale.
    assert.deepStrictEqual(
      check(
        [
          ...clean,
          delivery(
            inGen(
              `${bound("sender", "transactor")}const issueCode = () => transactor.run(commit).pipe(Effect.andThen(sender.send(email, key)));`
            )
          ),
        ],
        tolerated
      ),
      stale
    );

    // A name that is spelled as before and belongs to another service is not the call.
    assert.deepStrictEqual(
      check(
        [
          ...clean,
          delivery(
            inGen(
              "const transactor = yield* Transactor;\nconst sender = yield* Slack;\nconst issueCode = () => transactor.run(Effect.gen(function* () { yield* sender.send(email, key); }));"
            )
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

  it.effect(
    "R10 (round 3): `import x = require(…)` (also `import type` and `export import`) and a string-named `declare module` are imports, so an upward one is found",
    () =>
      Effect.gen(function* equalsAndAugmentations() {
        const team = `${d}/team/a.ts`;

        const forms = [
          ['import type Team = require("../team/a.ts");', "import type"],
          ['import Team = require("../team/a.ts");', "import"],
          ['export import Team = require("../team/a.ts");', "export import"],
          [
            'declare module "../team/a.ts" { interface Probe { readonly x: 1 } }',
            "declare module",
          ],
        ] as const;

        for (const [text, form] of forms) {
          assert.deepStrictEqual(
            mentioning(
              yield* findingsOf({ ...base, [kernel]: `${text}\n` }),
              kernel
            ),
            [upward(1, team)],
            form
          );
        }

        // Control: the same file without one of these forms is clean, so each finding is that form's.
        assert.deepStrictEqual(
          mentioning(
            yield* findingsOf({ ...base, [kernel]: "export const x = 1;\n" }),
            kernel
          ),
          []
        );
      }),
    120_000
  );

  it.effect(
    "R11 (round 3): import.meta.glob with a literal pattern imports every file it matches, so a glob that reaches another unit or a higher layer is found, and one that stays in its own unit is not",
    () =>
      Effect.gen(function* globsAreImports() {
        const redirects = "apps/web/src/server/redirects.ts";
        const cmsFile = "apps/cms/build/page.ts";

        const glob =
          'export const pages = import.meta.glob("../../../cms/build/*.ts", { eager: true });\n';

        // The same reach, written as a plain import: the finding to expect.
        const plain = mentioning(
          yield* findingsOf({
            ...base,
            [cmsFile]: "export const page = 1;\n",
            [redirects]: 'import "../../../cms/build/page.ts";\n',
          }),
          redirects
        );

        assert.lengthOf(plain, 1);
        assert.include(plain[0], "apps/cms");

        const found = mentioning(
          yield* findingsOf({
            ...base,
            [cmsFile]: "export const page = 1;\n",
            [redirects]: glob,
          }),
          redirects
        );

        assert.lengthOf(found, 1);
        assert.include(found[0], "apps/cms");

        // A glob in the governed tree is an edge to each match, so an upward one is found like an upward import.
        assert.deepStrictEqual(
          mentioning(
            yield* findingsOf({
              ...base,
              [kernel]: 'export const t = import.meta.glob("../team/*.ts");\n',
            }),
            kernel
          ),
          [upward(1, `${d}/team/a.ts`)]
        );

        // Control: a glob that stays in its own unit is no finding (the web tests glob their own sources this way).
        assert.deepStrictEqual(
          mentioning(
            yield* findingsOf({
              ...base,
              "apps/web/src/a.ts": "export const a = 1;\n",
              "apps/web/test/sources.test.ts":
                'export const sources = import.meta.glob("../src/**/*.{ts,tsx}", { query: "?raw" });\n',
            }),
            "apps/web/"
          ),
          []
        );
      }),
    120_000
  );

  it.effect(
    "R14 (glob base): a glob's unit is decided by the literal directory it starts in, so a glob that leaves its unit is found whatever it matches, and one that stays is not",
    () =>
      Effect.gen(function* globBaseDecidesTheUnit() {
        const importer = "apps/web/src/server/seeds.ts";

        const reach = (pattern: string, unit: string) =>
          `${importer}:1: apps/web reaches into ${unit} by the path ${pattern}; import the package by its name`;

        const scanned = (written: string, files: Record<string, string> = {}) =>
          findingsOf({ ...base, ...files, [importer]: written });

        // The reviewer's case: a glob of data files into another unit. No scanned source matches it, and it is found.
        const json = "../../../cms/seed/*.json";

        assert.deepStrictEqual(
          mentioning(
            yield* scanned(
              `export const seeds = import.meta.glob("${json}");\n`,
              {
                "apps/cms/seed/seed.json": "{}\n",
              }
            ),
            importer
          ),
          [reach(json, "apps/cms")]
        );

        // A glob that names a directory with no file in it reaches the same unit.
        assert.deepStrictEqual(
          mentioning(
            yield* scanned(
              `export const seeds = import.meta.glob("${json}");\n`
            ),
            importer
          ),
          [reach(json, "apps/cms")]
        );

        // Each brace alternative has its own directory; the one in the unit itself is no finding.
        const braces = "../../../{cms,web}/seed/*.json";

        assert.deepStrictEqual(
          mentioning(
            yield* scanned(
              `export const seeds = import.meta.glob("${braces}");\n`
            ),
            importer
          ),
          [reach(braces, "apps/cms")]
        );

        // A pattern that matches several sources of another unit is one finding, not one per match.
        const many = "../../../cms/build/*.ts";

        assert.deepStrictEqual(
          mentioning(
            yield* scanned(
              `export const pages = import.meta.glob("${many}");\n`,
              {
                "apps/cms/build/a.ts": "export const a = 1;\n",
                "apps/cms/build/b.ts": "export const b = 1;\n",
              }
            ),
            importer
          ),
          [reach(many, "apps/cms")]
        );

        // A pattern that starts above the units reaches every unit below it, and the unit it is written in is not one
        // (from `apps`, only the other app).
        const apps = "../../../**/*.json";

        assert.deepStrictEqual(
          mentioning(
            yield* scanned(`export const all = import.meta.glob("${apps}");\n`),
            importer
          ),
          [reach(apps, "apps/cms")]
        );

        const above = "../../../../**/*.json";

        assert.deepStrictEqual(
          mentioning(
            yield* scanned(
              `export const all = import.meta.glob("${above}");\n`
            ),
            importer
          ),
          [
            reach(above, "apps/cms"),
            reach(above, "packages/cms-client"),
            reach(above, "packages/db"),
            reach(above, "packages/domain"),
          ]
        );

        // Controls. The same data glob in the unit's own tree, and one into a directory that is in no unit, are clean.
        for (const stays of [
          "../../data/*.json",
          "./*.json",
          "../../../../docs/*.md",
        ]) {
          assert.deepStrictEqual(
            mentioning(
              yield* scanned(
                `export const x = import.meta.glob("${stays}");\n`
              ),
              importer
            ),
            [],
            stays
          );
        }

        // A negated pattern only removes files, so it reaches nowhere.
        assert.deepStrictEqual(
          mentioning(
            yield* scanned(
              `export const x = import.meta.glob(["./*.json", "!${json}"]);\n`
            ),
            importer
          ),
          []
        );
      }),
    120_000
  );

  it.effect(
    "R15 (review of #56): a glob's `base` option moves where its patterns start, a base that cannot be read fails closed, and the literal directory of a glob is placed after symbolic links",
    () =>
      Effect.gen(function* globBaseOption() {
        const importer = "apps/web/src/server/seeds.ts";
        const scanned = scannedGlob;

        const reach = (specifier: string, unit: string) =>
          `${importer}:1: apps/web reaches into ${unit} by the path ${specifier}; import the package by its name`;

        const unreadable = (text: string) =>
          `${importer}:1: ${text} loads modules by an expression that no check can read (the check fails closed): write the specifier as a plain string, or a glob pattern that starts with ./ or ../`;

        // A base from the importer's directory: the reviewer's first probe.
        assert.deepStrictEqual(
          yield* scanned(
            'export const s = import.meta.glob("./*.json", { base: "../../../cms/seed" });\n'
          ),
          [reach("./*.json (base ../../../cms/seed)", "apps/cms")]
        );

        // A base that starts with `/` is from the project's root: the directory of the importer's package.
        assert.deepStrictEqual(
          yield* scanned(
            'export const s = import.meta.glob("./*.json", { base: "/../cms/seed" });\n'
          ),
          [reach("./*.json (base /../cms/seed)", "apps/cms")]
        );

        // The pattern is read from the base, and a quoted key is a key.
        assert.deepStrictEqual(
          yield* scanned(
            'export const s = import.meta.glob(["../*.json"], { eager: true, "base": "../../../cms/seed/x" });\n'
          ),
          [reach("../*.json (base ../../../cms/seed/x)", "apps/cms")]
        );

        // Controls: a base inside the importer's own unit, from the importer or from the root, is clean, and so are
        // options with no base.
        for (const stays of [
          '{ base: "../../data" }',
          '{ base: "/public" }',
          '{ eager: true, query: "?raw" }',
        ]) {
          assert.deepStrictEqual(
            yield* scanned(
              `export const s = import.meta.glob("./*.json", ${stays});\n`
            ),
            [],
            stays
          );
        }

        // Options that cannot be read fail closed: a variable, a spread, a computed key, a base that is not a string.
        for (const options of [
          "opts",
          "{ ...opts }",
          "{ [key]: 1 }",
          "{ base: dir }",
          `{ base: \`${hole}/x\` }`,
        ]) {
          assert.deepStrictEqual(
            yield* scanned(
              `export const s = import.meta.glob("./*.json", ${options});\n`
            ),
            [unreadable(`import.meta.glob("./*.json", ${options})`)],
            options
          );
        }

        // A `/` base in a package with no `package.json` has no root to start from: it fails closed too.
        assert.deepStrictEqual(
          Arr.filter(
            mentioning(
              yield* findingsOf({
                ...base,
                "apps/other/src/x.ts":
                  'export const s = import.meta.glob("./*.json", { base: "/data" });\n',
              }),
              "apps/other/src/x.ts"
            ),
            (line) => line.includes("no check can read")
          ),
          [
            'apps/other/src/x.ts:1: import.meta.glob("./*.json", { base: "/data" }) loads modules by an expression that no check can read (the check fails closed): write the specifier as a plain string, or a glob pattern that starts with ./ or ../',
          ]
        );

        // The literal directories before the first wildcard are placed after symbolic links, as a plain import is: the
        // `vendor/domain` of the web package is `packages/domain`.
        const vendored = "../../vendor/domain/src/*.ts";

        assert.deepStrictEqual(
          yield* scanned(
            `export const s = import.meta.glob("${vendored}");\n`,
            { [`${d}/index.ts`]: "export const x = 1;\n" },
            { "apps/web/vendor/domain": "packages/domain" }
          ),
          [reach(vendored, "packages/domain")]
        );

        // Control: the same glob where the directory is a real directory of the web package is clean.
        assert.deepStrictEqual(
          yield* scanned(
            `export const s = import.meta.glob("${vendored}");\n`,
            {
              "apps/web/vendor/domain/src/a.ts": "export const a = 1;\n",
            }
          ),
          []
        );
      }),
    120_000
  );

  it.effect(
    "R16 (review of #56, round 2): a glob is placed only when nothing about it depends on how Vite expands it: no escape in its pattern, option keys or base, no node_modules, no symbolic link under a wildcard, a bounded walk",
    () =>
      Effect.gen(function* globsAreNotModelled() {
        const importer = "apps/web/src/server/seeds.ts";
        const scanned = scannedGlob;

        const refused = (text: string, reason: string) =>
          `${importer}:1: ${text}: glob not placeable: ${reason}; use a literal own-unit pattern`;

        const escape =
          "its pattern, an option key or its base is written with an escape (a backslash): the check reads the source text and Vite the string it spells";

        const slash = "\\u002f";

        // Strings that spell the reviewer's path with escapes: the source text is not the value that Vite reads.
        for (const call of [
          `"./*.json", { base: "..${slash}..${slash}..${slash}cms/seed" }`,
          `"./*.json", { "ba\\u0073e": "../../../cms/seed" }`,
          `"./*.json", { ba\\u0073e: "../../../cms/seed" }`,
          `"./..${slash}..${slash}..${slash}cms/seed/*.json"`,
        ]) {
          assert.deepStrictEqual(
            yield* scanned(`export const s = import.meta.glob(${call});\n`),
            [refused(`import.meta.glob(${call})`, escape)],
            call
          );
        }

        // Control: the same globs written without an escape are placed, and reach into another unit.
        assert.deepStrictEqual(
          yield* scanned(
            'export const s = import.meta.glob("./*.json", { base: "../../../cms/seed" });\n'
          ),
          [
            `${importer}:1: apps/web reaches into apps/cms by the path ./*.json (base ../../../cms/seed); import the package by its name`,
          ]
        );

        // A wildcard over a link to another package: Vite follows the link, a text match would not see it.
        const viaLink = "../../vendor/*/src/*.ts";

        assert.deepStrictEqual(
          yield* scanned(
            `export const s = import.meta.glob("${viaLink}", { exhaustive: true });\n`,
            { [`${d}/index.ts`]: "export const x = 1;\n" },
            { "apps/web/vendor/domain": "packages/domain" }
          ),
          [
            refused(
              `import.meta.glob("${viaLink}")`,
              "a symbolic link (apps/web/vendor/domain) is under a wildcard: Vite follows it to another package"
            ),
          ]
        );

        // ... and under `**`, however deep the link is.
        assert.deepStrictEqual(
          yield* scanned(
            'export const s = import.meta.glob("../**/*.ts");\n',
            { "apps/web/src/a/b/c.ts": "export const c = 1;\n" },
            { "apps/web/src/a/b/db": "packages/db" }
          ),
          [
            refused(
              'import.meta.glob("../**/*.ts")',
              "a symbolic link (apps/web/src/a/b/db) is under a wildcard: Vite follows it to another package"
            ),
          ]
        );

        // Control: the same globs over real directories of the web package are clean.
        assert.deepStrictEqual(
          yield* scanned(`export const s = import.meta.glob("${viaLink}");\n`, {
            "apps/web/vendor/domain/src/a.ts": "export const a = 1;\n",
          }),
          []
        );

        assert.deepStrictEqual(
          yield* scanned('export const s = import.meta.glob("../**/*.ts");\n', {
            "apps/web/src/a/b/c.ts": "export const c = 1;\n",
          }),
          []
        );

        // node_modules: by name in the pattern or the base, or reached by a wildcard, or through a link in the literal part.
        const named = "../../node_modules/@vektorprogrammet/*/src/*.ts";

        assert.deepStrictEqual(
          yield* scanned(
            `export const s = import.meta.glob("${named}", { exhaustive: true });\n`
          ),
          [
            refused(
              `import.meta.glob("${named}")`,
              "a segment of its pattern or base is node_modules"
            ),
          ]
        );

        assert.deepStrictEqual(
          yield* scanned(
            'export const s = import.meta.glob("./*/x.ts", { base: "../../node_modules" });\n'
          ),
          [
            refused(
              'import.meta.glob("./*/x.ts", { base: "../../node_modules" })',
              "a segment of its pattern or base is node_modules"
            ),
          ]
        );

        const reaching = "../../*/x.ts";

        assert.deepStrictEqual(
          yield* scanned(
            `export const s = import.meta.glob("${reaching}", { exhaustive: true });\n`,
            { "apps/web/node_modules/x.ts": "export const x = 1;\n" }
          ),
          [
            refused(
              `import.meta.glob("${reaching}")`,
              "a wildcard reaches node_modules (apps/web/node_modules)"
            ),
          ]
        );

        assert.deepStrictEqual(
          yield* scanned(
            'export const s = import.meta.glob("./*/x.ts", { base: "../../via" });\n',
            { "apps/web/node_modules/x.ts": "export const x = 1;\n" },
            { "apps/web/via": "apps/web/node_modules" }
          ),
          [
            refused(
              'import.meta.glob("./*/x.ts", { base: "../../via" })',
              "its base reaches node_modules (apps/web/node_modules) through a symbolic link"
            ),
          ]
        );

        // Control: the same wildcard with no node_modules in the directory is clean.
        assert.deepStrictEqual(
          yield* scanned(
            `export const s = import.meta.glob("${reaching}");\n`,
            { "apps/web/data/x.ts": "export const x = 1;\n" }
          ),
          []
        );

        // The walk is bounded: a glob that reaches more entries than the limit is refused; under the limit it is placed.
        const crowded = {
          "apps/web/data/a.ts": "export const a = 1;\n",
          "apps/web/data/b.ts": "export const b = 1;\n",
          "apps/web/data/c.ts": "export const c = 1;\n",
        };

        const within = (maxGlobEntries: number) =>
          Effect.gen(function* limited() {
            const repo = yield* tempRepo({
              ...base,
              "apps/web/package.json": "{}\n",
              ...crowded,
              [importer]:
                'export const s = import.meta.glob("../../data/*.ts");\n',
            });

            return mentioning(
              moduleGraphFindings(
                fixture,
                yield* readSources(
                  repo,
                  [importer, ...Rec.keys(crowded), ...Rec.keys(base)],
                  { maxGlobEntries }
                )
              ),
              importer
            );
          }).pipe(Effect.provide(NodeServices.layer));

        assert.deepStrictEqual(yield* within(2), [
          refused(
            'import.meta.glob("../../data/*.ts")',
            "its wildcards reach more than 2 entries (the walk of the disk is bounded)"
          ),
        ]);

        assert.deepStrictEqual(yield* within(3), []);
      }),
    120_000
  );

  it.effect(
    "R12 (round 3): an import() or import.meta.glob() with a computed argument, or a pattern that cannot be placed, is a finding, and a literal one is not",
    () =>
      Effect.gen(function* computedLoadsFail() {
        const lazy = "apps/web/src/server/lazy.ts";

        const finding = (line: number, text: string) =>
          `${lazy}:${line}: ${text} loads modules by an expression that no check can read (the check fails closed): write the specifier as a plain string, or a glob pattern that starts with ./ or ../`;

        assert.deepStrictEqual(
          mentioning(
            yield* findingsOf({
              ...base,
              [lazy]: Arr.join(
                [
                  `export const a = (name: string) => import(\`../${hole}.ts\`);`,
                  "export const b = (name: string) => import(name);",
                  "export const c = import.meta.glob(pattern);",
                  'export const d = import.meta.glob("/src/**/*.ts");',
                  'export const e = import.meta.glob("./[ab].ts");',
                ],
                "\n"
              ),
            }),
            lazy
          ),
          [
            finding(1, `import(\`../${hole}.ts\`)`),
            finding(2, "import(name)"),
            finding(3, "import.meta.glob(pattern)"),
            finding(4, 'import.meta.glob("/src/**/*.ts")'),
            finding(5, 'import.meta.glob("./[ab].ts")'),
          ]
        );

        // Control: a literal specifier and a placeable pattern are not findings.
        assert.deepStrictEqual(
          mentioning(
            yield* findingsOf({
              ...base,
              [lazy]:
                'export const a = () => import("./other.ts");\nexport const b = import.meta.glob("./*.ts");\n',
              "apps/web/src/server/other.ts": "export const o = 1;\n",
            }),
            "apps/web/"
          ),
          []
        );
      }),
    120_000
  );
});
