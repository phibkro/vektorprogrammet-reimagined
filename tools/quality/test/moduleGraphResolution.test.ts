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

const seeds = "apps/web/src/server/seeds.ts";

/** Directories that the globs below start in: an absent directory is refused, so each holds a file that no scan reads. */
const directories = {
  "apps/cms/seed/note.txt": "x\n",
  "apps/web/data/note.txt": "x\n",
  "docs/note.txt": "x\n",
};

/** The findings about `seeds`, which holds `written`, in a repository of `files` and `links`. */
const scannedGlob = (
  written: string,
  files: Record<string, string> = {},
  links: Record<string, string> = {}
) =>
  findingsOf(
    { ...base, ...directories, ...files, [seeds]: written },
    links
  ).pipe(Effect.map((found) => mentioning(found, seeds)));

/** The finding for a glob of `apps/web` that reaches into `unit`. */
const reach = (pattern: string, unit: string) =>
  `${seeds}:1: apps/web reaches into ${unit} by the path ${pattern}; import the package by its name`;

/** A file that holds one `import.meta.glob` of `pattern`. */
const globOf = (pattern: string) =>
  `export const s = import.meta.glob("${pattern}");\n`;

/** The reason for a pattern that is not of the closed grammar. */
const grammar = (pattern: string) =>
  `its pattern ${pattern} is not ./ or ../, literal directories of letters, digits, _ and -, an optional **/, and *.ext or *.{ext,ext}`;

/** The finding for a glob that is not placed: its arguments as written, and why. */
const refusal = (call: string, reason: string) =>
  `${seeds}:1: import.meta.glob(${call}): glob not placeable: ${reason}; use a literal own-unit pattern`;

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
    "R14 (glob grammar): a glob of the closed grammar is placed at the directory it starts in, so one that leaves its unit is found whatever it matches, and one that stays is not",
    () =>
      Effect.gen(function* placedGlobs() {
        // The reviewer's case: data files of another unit, with and without a file in the directory.
        const json = "../../../cms/seed/*.json";

        for (const files of [{ "apps/cms/seed/seed.json": "{}\n" }, {}]) {
          assert.deepStrictEqual(yield* scannedGlob(globOf(json), files), [
            reach(json, "apps/cms"),
          ]);
        }

        // Alternatives of extensions, `**`, and an array: each pattern is one finding however many files it matches.
        for (const [pattern, files] of [
          ["../../../cms/seed/*.{json,ts}", {}],
          [
            "../../../cms/build/**/*.ts",
            {
              "apps/cms/build/a.ts": "export const a = 1;\n",
              "apps/cms/build/deep/b.ts": "export const b = 1;\n",
            },
          ],
          [
            "../../../cms/build/*.ts",
            {
              "apps/cms/build/a.ts": "export const a = 1;\n",
              "apps/cms/build/b.ts": "export const b = 1;\n",
            },
          ],
          ["../../../*.json", {}],
        ] as const) {
          assert.deepStrictEqual(
            yield* scannedGlob(globOf(pattern), files),
            [reach(pattern, "apps/cms")],
            pattern
          );
        }

        assert.deepStrictEqual(
          yield* scannedGlob(
            `export const s = import.meta.glob(["../../data/*.json", "${json}"]);\n`
          ),
          [reach(json, "apps/cms")]
        );

        // Controls: the same shapes inside the unit, or in a directory that is in no unit, are clean.
        for (const stays of [
          "../../data/*.json",
          "./*.json",
          "../../data/**/*.{json,ts}",
          "../../../../docs/*.md",
        ]) {
          assert.deepStrictEqual(yield* scannedGlob(globOf(stays)), [], stays);
        }

        // Options that the grammar allows change nothing.
        assert.deepStrictEqual(
          yield* scannedGlob(
            `export const s = import.meta.glob("${json}", { eager: true, "import": 'default', query: "?raw" });\n`
          ),
          [reach(json, "apps/cms")]
        );
      }),
    120_000
  );

  it.effect(
    "R15 (glob grammar): every other spelling is a finding that adds no edge (brace ranges, braces, wildcards in a directory, dotted and parent segments, negation, escapes, options other than eager, import and query), and each plain form beside it is placed",
    () =>
      Effect.gen(function* refusedGlobs() {
        const slash = "\\u002f";

        // Patterns: the reviewer's brace range and every form of the grammar's complement.
        const patterns: readonly (readonly [string, string])[] = [
          [
            "../../../c{l..n}s/seed/*.json",
            grammar("../../../c{l..n}s/seed/*.json"),
          ],
          [
            "../../../{cms,web}/seed/*.json",
            grammar("../../../{cms,web}/seed/*.json"),
          ],
          [
            "../../../cms/seed/*.{json,yaml}x",
            grammar("../../../cms/seed/*.{json,yaml}x"),
          ],
          ["./[ab].ts", grammar("./[ab].ts")],
          ["./a?.ts", grammar("./a?.ts")],
          ["./a(b).ts", grammar("./a(b).ts")],
          ["../*/seed/*.json", grammar("../*/seed/*.json")],
          ["./**/**/*.ts", grammar("./**/**/*.ts")],
          ["./a/**b/*.ts", grammar("./a/**b/*.ts")],
          ["../../../cms/see.d/*.json", grammar("../../../cms/see.d/*.json")],
          ["./.hidden/*.json", grammar("./.hidden/*.json")],
          ["./a/../b/*.ts", grammar("./a/../b/*.ts")],
          ["./*.d.ts", grammar("./*.d.ts")],
          ["./*", grammar("./*")],
          ["./*.{ts}", grammar("./*.{ts}")],
          ["./*.{json}", grammar("./*.{json}")],
          ["src/*.ts", grammar("src/*.ts")],
          ["/src/*.ts", grammar("/src/*.ts")],
          ["@/lib/*.ts", grammar("@/lib/*.ts")],
          ["./é/*.ts", grammar("./é/*.ts")],
          [
            "../../node_modules/x/*.ts",
            "a segment of its pattern is node_modules",
          ],
          ["./node_modules/*.ts", "a segment of its pattern is node_modules"],
          ["!./a.ts", "a negated pattern is not read"],
          ["../../../../../../../x/*.ts", "its pattern leaves the repository"],
        ];

        for (const [pattern, reason] of patterns) {
          assert.deepStrictEqual(
            yield* scannedGlob(
              `export const s = import.meta.glob("${pattern}");\n`
            ),
            [refusal(`"${pattern}"`, reason)],
            pattern
          );
        }

        // One refused pattern in an array is one finding, and the placed one beside it still counts.
        assert.deepStrictEqual(
          yield* scannedGlob(
            'export const s = import.meta.glob(["../../data/*.json", "./*.json", "!./a.json"]);\n'
          ),
          [refusal('"!./a.json"', "a negated pattern is not read")]
        );

        // Strings written with an escape: the source text is not the value that Vite reads.
        const escaped =
          "its pattern is written with an escape (a backslash): the check reads the source text and Vite the string it spells";

        const escapes: readonly (readonly [string, string])[] = [
          [`"./..${slash}..${slash}..${slash}cms/seed/*.json"`, escaped],
          [
            `"./*.json", { base: "..${slash}..${slash}..${slash}cms/seed" }`,
            "its option base is not one of eager, import and query",
          ],
          [
            '"./*.json", { "ba\\u0073e": "../../../cms/seed" }',
            'its option "ba\\u0073e" is not one of eager, import and query',
          ],
          [
            '"./*.json", { e\\u0061ger: true }',
            "its option e\\u0061ger is not one of eager, import and query",
          ],
          [
            '"./*.json", { query: "?r\\u0061w" }',
            "the value of its option query is not a boolean or a plain string",
          ],
        ];

        for (const [call, reason] of escapes) {
          assert.deepStrictEqual(
            yield* scannedGlob(`export const s = import.meta.glob(${call});\n`),
            [refusal(call, reason)],
            call
          );
        }

        // Options: only eager, import and query, with a boolean or a plain string. `base` and `caseSensitive` change where a
        // glob starts and what it matches, `exhaustive` what it skips, `__proto__` and side effects what `base` is.
        const options: readonly (readonly [string, string])[] = [
          [
            '{ base: "../../../cms/seed" }',
            "its option base is not one of eager, import and query",
          ],
          [
            '{ "base": "/../cms/seed" }',
            'its option "base" is not one of eager, import and query',
          ],
          [
            "{ caseSensitive: false }",
            "its option caseSensitive is not one of eager, import and query",
          ],
          [
            "{ exhaustive: true }",
            "its option exhaustive is not one of eager, import and query",
          ],
          [
            '{ __proto__: { base: "../../../cms/seed" } }',
            "its option __proto__ is not one of eager, import and query",
          ],
          [
            '{ "__proto__": { base: "../../../cms/seed" } }',
            'its option "__proto__" is not one of eager, import and query',
          ],
          [
            '{ import: Object.prototype.base = "../../../cms/seed" }',
            "the value of its option import is not a boolean or a plain string",
          ],
          [
            "{ eager: yes }",
            "the value of its option eager is not a boolean or a plain string",
          ],
          [
            `{ query: \`?${hole}\` }`,
            "the value of its option query is not a boolean or a plain string",
          ],
          [
            "{ ...opts }",
            "its options hold a spread, computed key, shorthand or method",
          ],
          [
            "{ [key]: true }",
            "its options hold a spread, computed key, shorthand or method",
          ],
          [
            "{ eager }",
            "its options hold a spread, computed key, shorthand or method",
          ],
          [
            "{ eager() { return true; } }",
            "its options hold a spread, computed key, shorthand or method",
          ],
          [
            "{ get eager() { return true; } }",
            "its options hold a spread, computed key, shorthand or method",
          ],
          ["opts", "its options are not an object literal"],
          ["[]", "its options are not an object literal"],
        ];

        for (const [written, reason] of options) {
          const call = `"./*.json", ${written}`;

          assert.deepStrictEqual(
            yield* scannedGlob(`export const s = import.meta.glob(${call});\n`),
            [refusal(call, reason)],
            written
          );
        }

        assert.deepStrictEqual(
          yield* scannedGlob(
            'export const s = import.meta.glob("./*.json", { eager: true }, extra);\n'
          ),
          [
            refusal(
              '"./*.json", { eager: true }, extra',
              "it has more than two arguments"
            ),
          ]
        );

        // Controls: the plain forms beside every refusal are placed, and an own-unit glob adds no finding.
        for (const plain of [
          'import.meta.glob("./*.json")',
          'import.meta.glob("./*.json", {})',
          'import.meta.glob("./*.json", { eager: true })',
          'import.meta.glob("./*.json", { "eager": false, \'import\': "default", query: "?raw" })',
          'import.meta.glob<string>(["./*.json", "../../data/*.{json,ts}"], { eager: true })',
        ]) {
          assert.deepStrictEqual(
            yield* scannedGlob(`export const s = ${plain};\n`),
            [],
            plain
          );
        }
      }),
    120_000
  );

  it.effect(
    "R16 (glob grammar): the disk is walked without following a link: a link in the literal directory or under a wildcard, node_modules under `**` and a walk past its bound each refuse the glob, and the same globs over plain directories are placed",
    () =>
      Effect.gen(function* walkedGlobs() {
        // A link in the literal directory: the directory written is not the one Vite reads. Reached through the link, the
        // files are another package's, and the check would decide the unit and the edges from the text.
        const vendored = "../../vendor/src/*.ts";

        assert.deepStrictEqual(
          yield* scannedGlob(
            globOf(vendored),
            { [`${d}/src/a.ts`]: "export const a = 1;\n" },
            { "apps/web/vendor": "packages/domain" }
          ),
          [
            refusal(
              `"${vendored}"`,
              "a symbolic link (apps/web/vendor) is in its directory"
            ),
          ]
        );

        // Inside one package: a link from the governed tree's `lnk` to `src/team` hides an upward import.
        const lnk = "../../lnk/*.ts";

        assert.deepStrictEqual(
          mentioning(
            yield* findingsOf(
              {
                ...base,
                [`${d}/team/a.ts`]: "export const a = 1;\n",
                [kernel]: globOf(lnk),
              },
              { "packages/domain/lnk": "packages/domain/src/team" }
            ),
            kernel
          ),
          [
            `${kernel}:1: import.meta.glob("${lnk}"): glob not placeable: a symbolic link (packages/domain/lnk) is in its directory; use a literal own-unit pattern`,
          ]
        );

        // Under a wildcard: `**` reaches a link however deep it is, and the last segment reaches a link to a file.
        const deep = "../**/*.ts";

        assert.deepStrictEqual(
          yield* scannedGlob(
            globOf(deep),
            { "apps/web/src/a/b/c.ts": "export const c = 1;\n" },
            { "apps/web/src/a/b/db": "packages/db" }
          ),
          [
            refusal(
              `"${deep}"`,
              "a symbolic link (apps/web/src/a/b/db) is under a wildcard: Vite follows it to another package"
            ),
          ]
        );

        assert.deepStrictEqual(
          yield* scannedGlob(
            globOf("./*.ts"),
            { [`${d}/index.ts`]: "export const x = 1;\n" },
            { "apps/web/src/server/linked.ts": `${d}/index.ts` }
          ),
          [
            refusal(
              '"./*.ts"',
              "a symbolic link (apps/web/src/server/linked.ts) is under a wildcard: Vite follows it to another package"
            ),
          ]
        );

        // node_modules under `**`.
        assert.deepStrictEqual(
          yield* scannedGlob(globOf(deep), {
            "apps/web/src/node_modules/x.ts": "export const x = 1;\n",
          }),
          [
            refusal(
              `"${deep}"`,
              "a wildcard reaches node_modules (apps/web/src/node_modules)"
            ),
          ]
        );

        // A one-item brace is literal text for picomatch, not `*.ts`: the file `x.{ts}` is a link that the walk would not
        // look at if the check read the brace as an extension. It is refused as a pattern, and the two-item form is placed.
        assert.deepStrictEqual(
          yield* scannedGlob(
            globOf("./data/*.{ts}"),
            {},
            { "apps/web/src/server/data/x.{ts}": "apps/cms/seed/note.txt" }
          ),
          [refusal('"./data/*.{ts}"', grammar("./data/*.{ts}"))]
        );

        assert.deepStrictEqual(
          yield* scannedGlob(globOf("./data/*.{ts,tsx}"), {
            "apps/web/src/server/data/a.ts": "export const a = 1;\n",
          }),
          []
        );

        // A dangling link in the directory: `lstat` sees it, `exists` and `realPath` do not. It is refused, below the
        // wildcard too, with a target that is absent and with one that is present.
        for (const [pattern, link, target] of [
          ["./data/*.json", "apps/web/src/server/data", "apps/cms/missing"],
          ["./data/sub/*.json", "apps/web/src/server/data", "apps/cms/missing"],
          ["./data/*.json", "apps/web/src/server/data", "apps/cms/seed"],
        ] as const) {
          assert.deepStrictEqual(
            yield* scannedGlob(globOf(pattern), {}, { [link]: target }),
            [
              refusal(
                `"${pattern}"`,
                "a symbolic link (apps/web/src/server/data) is in its directory"
              ),
            ],
            `${pattern} -> ${target}`
          );
        }

        assert.deepStrictEqual(
          yield* scannedGlob(globOf("./data/sub/*.json"), {
            "apps/web/src/server/data/sub/a.json": "{}\n",
          }),
          []
        );

        // A directory that is not there cannot be placed; a file where a directory should be is not a directory either.
        assert.deepStrictEqual(yield* scannedGlob(globOf("./nowhere/*.json")), [
          refusal(
            '"./nowhere/*.json"',
            "its directory apps/web/src/server/nowhere does not exist"
          ),
        ]);

        assert.deepStrictEqual(
          yield* scannedGlob(globOf("./data/*.json"), {
            "apps/web/src/server/data": "a file, not a directory\n",
          }),
          [
            refusal(
              '"./data/*.json"',
              "its directory apps/web/src/server/data is not a directory"
            ),
          ]
        );

        // Controls: the same globs over plain directories are placed and clean.
        assert.deepStrictEqual(
          yield* scannedGlob(globOf(vendored), {
            "apps/web/vendor/src/a.ts": "export const a = 1;\n",
          }),
          []
        );

        assert.deepStrictEqual(
          yield* scannedGlob(globOf(deep), {
            "apps/web/src/a/b/c.ts": "export const c = 1;\n",
          }),
          []
        );

        assert.deepStrictEqual(
          yield* scannedGlob(globOf("./*.ts"), {
            "apps/web/src/server/plain.ts": "export const p = 1;\n",
          }),
          []
        );

        // The bound counts every directory entry that is read, whether the glob matches it or not: three entries that
        // the extension does not match, and one that it does, are four.
        const crowded = {
          "apps/web/data/a.txt": "a\n",
          "apps/web/data/b.txt": "b\n",
          "apps/web/data/c.txt": "c\n",
          "apps/web/data/d.ts": "export const d = 1;\n",
        };

        const within = (maxGlobEntries: number) =>
          Effect.gen(function* limited() {
            const repo = yield* tempRepo({
              ...base,
              ...crowded,
              [seeds]: globOf("../../data/*.ts"),
            });

            return mentioning(
              moduleGraphFindings(
                fixture,
                yield* readSources(
                  repo,
                  [seeds, ...Rec.keys(crowded), ...Rec.keys(base)],
                  { maxGlobEntries }
                )
              ),
              seeds
            );
          }).pipe(Effect.provide(NodeServices.layer));

        assert.deepStrictEqual(yield* within(3), [
          refusal(
            '"../../data/*.ts"',
            "it reads more than 3 directory entries (the walk of the disk is bounded)"
          ),
        ]);

        assert.deepStrictEqual(yield* within(4), []);
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
            `${lazy}:4: import.meta.glob("/src/**/*.ts"): glob not placeable: its pattern /src/**/*.ts is not ./ or ../, literal directories of letters, digits, _ and -, an optional **/, and *.ext or *.{ext,ext}; use a literal own-unit pattern`,
            `${lazy}:5: import.meta.glob("./[ab].ts"): glob not placeable: its pattern ./[ab].ts is not ./ or ../, literal directories of letters, digits, _ and -, an optional **/, and *.ext or *.{ext,ext}; use a literal own-unit pattern`,
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
