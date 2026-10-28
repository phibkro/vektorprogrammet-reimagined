import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, Order } from "effect";

import { importSpecifiers } from "../importSpecifiers.ts";
import { baseline, declaration, integrationCalls } from "../moduleGraph.ts";
import type { Declaration } from "../moduleGraph.ts";
import { moduleGraphFindings, scanImports } from "../moduleGraphCheck.ts";
import { moduleGraphProbes } from "../probes.ts";
import type { SourceFile } from "../resolveImports.ts";
import { lintProbes } from "./support/lintProbes.ts";
import {
  at,
  check,
  clean,
  d,
  fixture,
  importing,
  mentioning,
  parsed,
  replacing,
  source,
} from "./support/moduleGraphFixture.ts";

const root = new URL("../../../", import.meta.url).pathname;

/** A probe file as the check reads it. */
const asSource = ({
  content,
  file,
}: {
  readonly content: string;
  readonly file: string;
}): SourceFile => parsed(file, content);

describe("module graph (spec 0020, ADR 0015 stage 1)", () => {
  it("the fixture is clean, so each case below changes one thing", () => {
    assert.deepStrictEqual(check(clean), []);
  });

  it("finds every import form and skips text that only mentions a package", () => {
    const specifiers = importSpecifiers(
      "probe.ts",
      Arr.join(
        [
          'import { a } from "./a.ts";',
          'import type { B } from "../b.ts";',
          'export * from "@scope/pkg/sub";',
          'export { c } from "effect/rpc";',
          'export const d = import("node:fs");',
          "export const e = import(someVariable);",
          'export const f = "import { x } from \\"./nope.ts\\"";',
          '// import { y } from "./nope.ts"',
        ],
        "\n"
      )
    );

    assert.deepStrictEqual(specifiers, [
      { line: 1, specifier: "./a.ts" },
      { line: 2, specifier: "../b.ts" },
      { line: 3, specifier: "@scope/pkg/sub" },
      { line: 4, specifier: "effect/rpc" },
      { line: 5, specifier: "node:fs" },
    ]);
  });

  describe("F1: a cycle fails", () => {
    const login = `${d}/login/a.ts`;
    const team = `${d}/team/a.ts`;
    const contact = `${d}/contact/a.ts`;

    it("a file in `team` that imports `login`, which imports `team`, fails and prints both import sites", () => {
      const findings = check(importing(team, "../login/a.ts"));

      const edge = at(findings, `${team}:2`);

      assert.notStrictEqual(edge, "");
      assert.include(edge, "which module team does not declare in uses");
      assert.include(edge, `${login}:1 (login imports team)`);

      // The two files also import each other.
      assert.deepStrictEqual(
        mentioning(findings, "import cycle between 2 files"),
        [
          Arr.join(
            [
              "import cycle between 2 files:",
              `  ${login}:1 imports ${team}`,
              `  ${team}:2 imports ${login}`,
            ],
            "\n"
          ),
        ]
      );
    });

    it("control: the same map without the new import passes", () => {
      assert.deepStrictEqual(check(clean), []);
    });

    it("a cycle through three modules prints every hop", () => {
      // team -> contact -> login -> team: three modules and three files in one cycle.
      const findings = check(
        Arr.map(importing(team, "../contact/a.ts"), (file) =>
          file.path === contact
            ? source(
                contact,
                "../vocab/ids.ts",
                "sanitize-html",
                "../login/a.ts"
              )
            : file
        )
      );

      const edge = at(findings, `${team}:2`);

      assert.notStrictEqual(edge, "");
      assert.include(edge, `${contact}:3 (contact imports login)`);
      assert.include(edge, `${login}:1 (login imports team)`);
      assert.lengthOf(mentioning(findings, "import cycle between 3 files"), 1);
    });
  });

  describe("F2: an upward import fails", () => {
    it("a library that imports a service fails", () => {
      const [found, ...others] = check(
        importing(`${d}/kernel/a.ts`, "../team/a.ts")
      );

      assert.deepStrictEqual(others, []);
      assert.include(
        found,
        `${d}/kernel/a.ts:3: imports ${d}/team/a.ts (module team, service), an upward import from module kernel (library)`
      );
    });

    it("a service that imports the catalog fails", () => {
      const [found, ...others] = check(
        importing(`${d}/contact/a.ts`, "../catalog/a.ts")
      );

      assert.deepStrictEqual(others, []);
      assert.include(found, "an upward import from module contact (service)");
    });

    it("the catalog that imports Privacy fails", () => {
      const findings = check(importing(`${d}/catalog/a.ts`, "../privacy/a.ts"));

      assert.lengthOf(
        mentioning(findings, "an upward import from module catalog (catalog)"),
        1
      );
    });

    it("control: the same edges in the allowed direction pass", () => {
      // `clean` holds library -> library, service -> library, service -> service, catalog -> services, Privacy ->
      // catalog and assembly -> Privacy.
      assert.deepStrictEqual(check(clean), []);
    });

    it("an upward `uses` in the declaration fails by itself", () => {
      const upward: Declaration = {
        ...fixture,
        modules: Arr.map(fixture.modules, (module) =>
          module.name === "kernel"
            ? { ...module, uses: ["vocab", "team"] }
            : module
        ),
      };

      assert.lengthOf(
        mentioning(
          check(clean, upward),
          "module kernel (library) declares team (service), a higher layer"
        ),
        1
      );
    });
  });

  describe("F3: an undeclared sideways edge fails", () => {
    it("`contact` importing `login` fails", () => {
      const [found, ...others] = check(
        importing(`${d}/contact/a.ts`, "../login/a.ts")
      );

      assert.deepStrictEqual(others, []);
      assert.include(
        found,
        `${d}/contact/a.ts:3: imports ${d}/login/a.ts (module login, service), which module contact does not declare in uses`
      );
    });

    it("control: the declared edge `login` -> `team` passes", () => {
      assert.deepStrictEqual(
        check(
          replacing(
            source(`${d}/login/a.ts`, "../team/a.ts", "../vocab/ids.ts")
          )
        ),
        []
      );
    });

    it("a declaration with a cycle in `uses` fails by itself", () => {
      const cyclic: Declaration = {
        ...fixture,
        modules: Arr.map(fixture.modules, (module) =>
          module.name === "team"
            ? { ...module, uses: ["vocab", "login"] }
            : module
        ),
      };

      assert.lengthOf(
        mentioning(
          check(clean, cyclic),
          "the declared graph has a cycle between modules login, team"
        ),
        1
      );
    });
  });

  describe("F4: the ratchet", () => {
    const wider: Declaration = {
      ...fixture,
      modules: Arr.map(fixture.modules, (module) =>
        module.name === "team"
          ? { ...module, uses: ["vocab", "kernel"] }
          : module
      ),
    };

    it("a declared edge that no file uses fails", () => {
      assert.deepStrictEqual(check(clean, wider), [
        "module team declares kernel, but no file of team imports it; remove it from uses",
      ]);
    });

    it("control: removing it from the declaration passes", () => {
      assert.deepStrictEqual(check(clean, fixture), []);
    });

    it("a unit's declared package that no file imports fails, and removing it passes", () => {
      const wide: Declaration = {
        ...fixture,
        units: Arr.map(fixture.units, (unit) =>
          unit.root === "apps/cms" ? { ...unit, uses: ["packages/db"] } : unit
        ),
      };

      assert.deepStrictEqual(check(clean, wide), [
        "unit apps/cms declares packages/db, but no file of apps/cms imports it; remove it from units",
      ]);

      assert.deepStrictEqual(check(clean, fixture), []);
    });
  });

  describe("F5: a file outside every module fails", () => {
    it("a file in a new directory matches no module", () => {
      assert.deepStrictEqual(
        mentioning(
          check(replacing(source(`${d}/newplace/thing.ts`, "effect"))),
          "newplace"
        ),
        [
          `${d}/newplace/thing.ts: belongs to no module (${fixture.governed}); list it in a module of tools/quality/moduleGraph.ts`,
        ]
      );
    });

    it("control: the same file under a mapped glob passes", () => {
      assert.deepStrictEqual(
        check(replacing(source(`${d}/team/thing.ts`, "effect"))),
        []
      );
    });

    it("a file that two modules list fails", () => {
      const twice: Declaration = {
        ...fixture,
        modules: Arr.map(fixture.modules, (module) =>
          module.name === "kernel"
            ? { ...module, files: [...module.files, `${d}/team/*.ts`] }
            : module
        ),
      };

      assert.lengthOf(
        mentioning(
          check(clean, twice),
          "belongs to more than one module (kernel, team)"
        ),
        1
      );
    });

    it("`except` takes a file out of a glob, and a glob that matches nothing fails", () => {
      const moved: Declaration = {
        ...fixture,
        modules: Arr.map(fixture.modules, (module) =>
          module.name === "team"
            ? { ...module, except: [`${d}/team/a.ts`] }
            : module
        ),
      };

      assert.lengthOf(
        mentioning(check(clean, moved), `${d}/team/a.ts: belongs to no module`),
        1
      );

      assert.lengthOf(
        mentioning(
          check(Arr.filter(clean, (file) => file.path !== `${d}/index.ts`)),
          `module assembly lists ${d}/index.ts, which matches no file`
        ),
        1
      );
    });
  });

  describe("F6: a module with runtime fails", () => {
    it("a library that imports a Node module, a Cloudflare module or the database package fails", () => {
      assert.deepStrictEqual(
        check(
          importing(
            `${d}/vocab/ids.ts`,
            "node:fs",
            "cloudflare:workers",
            "@vektorprogrammet/db"
          )
        ),
        [
          `${d}/vocab/ids.ts:2: module vocab imports node:fs, and a module imports only effect`,
          `${d}/vocab/ids.ts:3: module vocab imports cloudflare:workers, and a module imports only effect`,
          `${d}/vocab/ids.ts:4: packages/domain imports packages/db, which it does not declare in units`,
        ]
      );
    });

    it("control: an import of `effect` and of its subpaths passes", () => {
      assert.deepStrictEqual(
        check(importing(`${d}/vocab/ids.ts`, "effect/Array", "effect/rpc")),
        []
      );
    });

    it("a package that a module's row names passes there and fails elsewhere", () => {
      // `contact` names it (in `clean`); `team` does not.
      assert.deepStrictEqual(
        check(importing(`${d}/team/a.ts`, "sanitize-html")),
        [
          `${d}/team/a.ts:2: module team imports sanitize-html, and a module imports only effect`,
        ]
      );
    });
  });

  describe("F7: package rows", () => {
    const seed = "apps/web/test/seed.test.ts";
    const leak = "../../cms/seed/seed.json";

    const tolerated: Declaration = {
      ...fixture,
      baseline: [
        { from: seed, reason: "a test reads the CMS seed", to: "apps/cms" },
      ],
    };

    it("`apps/web` that reaches `apps/cms` by a path or by its name fails", () => {
      assert.deepStrictEqual(
        check(
          replacing(
            source(
              "apps/web/src/server/a.ts",
              "@vektorprogrammet/domain",
              "@vektorprogrammet/db",
              "../../../cms/seed/seed.json",
              "@vektorprogrammet/cms"
            )
          )
        ),
        [
          "apps/web/src/server/a.ts:3: apps/web reaches into apps/cms by the path ../../../cms/seed/seed.json; import the package by its name",
          "apps/web/src/server/a.ts:4: apps/web imports apps/cms, which it does not declare in units",
        ]
      );
    });

    it("`packages/domain` that imports a workspace package fails", () => {
      assert.deepStrictEqual(
        check(importing(`${d}/vocab/ids.ts`, "@vektorprogrammet/cms-client")),
        [
          `${d}/vocab/ids.ts:2: packages/domain imports packages/cms-client, which it does not declare in units`,
        ]
      );
    });

    it("a package that is no unit fails, and so does a file that belongs to none", () => {
      assert.deepStrictEqual(
        check(
          replacing(source(`${d}/vocab/ids.ts`, "@vektorprogrammet/elsewhere"))
        ),
        [
          `${d}/vocab/ids.ts:1: imports @vektorprogrammet/elsewhere, which names no unit of tools/quality/moduleGraph.ts`,
        ]
      );

      assert.deepStrictEqual(
        check(replacing(source("packages/new/src/a.ts", "effect"))),
        [
          "packages/new/src/a.ts: belongs to no unit; add its package to the units of tools/quality/moduleGraph.ts",
        ]
      );
    });

    it("control: a baselined leak passes, and a baselined leak that no file needs fails", () => {
      assert.deepStrictEqual(
        check(replacing(source(seed, leak)), tolerated),
        []
      );

      assert.deepStrictEqual(
        check(replacing(source(seed, "effect")), tolerated),
        [
          `baseline: ${seed} -> apps/cms is not a broken rule any more (a test reads the CMS seed); remove the entry`,
        ]
      );
    });

    it("the baseline covers only the pair it names", () => {
      assert.deepStrictEqual(
        check(
          replacing(
            source(seed, leak),
            source("apps/web/test/other.test.ts", leak)
          ),
          tolerated
        ),
        [
          "apps/web/test/other.test.ts:1: apps/web reaches into apps/cms by the path ../../cms/seed/seed.json; import the package by its name",
        ]
      );
    });
  });

  describe("F8: the oracle", () => {
    const probes = {
      cycleA: {
        content:
          'import { b } from "./moduleGraphProbeCycleB.ts";\n\nexport const a = b;\n',
        file: moduleGraphProbes.cycleA,
      },
      cycleB: {
        content:
          'import type { a } from "./moduleGraphProbeCycleA.ts";\n\nexport const b = 1;\n\nexport type T = typeof a;\n',
        file: moduleGraphProbes.cycleB,
      },
      flatA: {
        content:
          'import { b } from "./moduleGraphProbeFlatB.ts";\n\nexport const a = b;\n',
        file: moduleGraphProbes.flatA,
      },
      flatB: {
        content: "export const b = 1;\n",
        file: moduleGraphProbes.flatB,
      },
    } as const;

    it("a fixture with a known cycle: the check says cycle, and the control says none", () => {
      assert.lengthOf(
        mentioning(
          check([asSource(probes.cycleA), asSource(probes.cycleB)]),
          "import cycle between 2 files"
        ),
        1
      );

      assert.deepStrictEqual(
        mentioning(
          check([asSource(probes.flatA), asSource(probes.flatB)]),
          "import cycle"
        ),
        []
      );
    });

    it.effect(
      "Oxlint's `import/no-cycle` gives the same verdict on the same fixture, and none for the real domain",
      () =>
        Effect.gen(function* oxlintAgrees() {
          // The governed files, listed by the same scan that skips probes, not the directory: a probe that another
          // test writes there for a moment is never an argument of this lint (review round 1: the F8 race).
          const governed = Arr.map(
            Arr.filter(
              yield* scanImports(root),
              ({ path }) => path.startsWith(`${d}/`) && path.endsWith(".ts")
            ),
            ({ path }) => path
          );

          // Only the rule that is compared, through the real configuration: the other rules are another test's business.
          const diagnostics = yield* lintProbes(root, probes, governed, [
            "-A",
            "all",
            "-D",
            "import/no-cycle",
          ]);

          const cyclic = Arr.sort(
            Arr.dedupe(
              Arr.flatMap(diagnostics, (item) =>
                item.code === "import(no-cycle)" ? [item.filename] : []
              )
            ),
            Order.String
          );

          // Both files of the cycle, and no other: not the flat pair, not a file of the real domain.
          assert.deepStrictEqual(cyclic, [
            probes.cycleA.file,
            probes.cycleB.file,
          ]);
        }).pipe(Effect.provide(NodeServices.layer)),
      180_000
    );
  });

  describe("F9: the real tree", () => {
    it.effect(
      "reports exactly the baselined imports, and one more import adds one finding",
      () =>
        Effect.gen(function* realTree() {
          const files = yield* scanImports(root);

          assert.deepStrictEqual(moduleGraphFindings(declaration, files), []);

          // Without the baseline each entry is one finding, and the file graph of the packages is acyclic (the
          // oracle's other half): the baseline is exactly what breaks a rule today.
          const without = moduleGraphFindings(
            { ...declaration, baseline: [] },
            files
          );

          assert.lengthOf(without, baseline.length);
          assert.deepStrictEqual(mentioning(without, "import cycle"), []);

          assert.deepStrictEqual(
            Arr.sort(
              Arr.map(without, (finding) =>
                finding.slice(0, finding.indexOf(":"))
              ),
              Order.String
            ),
            Arr.sort(
              Arr.map(baseline, ({ from }) => from),
              Order.String
            )
          );

          // A new real import, `contact` using `iam`, which no declared edge allows, is one more finding.
          const mutated = Arr.map(files, (file) =>
            file.path === `${d}/contact/commands.ts`
              ? {
                  ...file,
                  imports: [
                    ...file.imports,
                    {
                      line: 9999,
                      specifier: "../accounts/declaration.ts",
                      target: {
                        kind: "file" as const,
                        path: `${d}/accounts/declaration.ts`,
                      },
                    },
                  ],
                }
              : file
          );

          assert.lengthOf(moduleGraphFindings(declaration, mutated), 1);
        }).pipe(Effect.provide(NodeServices.layer)),
      120_000
    );

    it("the baseline is pinned: a stage that removes an import lowers the count, and nothing adds to it", () => {
      // Three imports between modules (ADR 0015 stages 2 and 3 remove them) and five between packages (stage 5).
      assert.lengthOf(baseline, 8);

      // One call of another system inside a transaction that the type bound does not see (review round 1).
      assert.deepStrictEqual(
        Arr.map(
          integrationCalls,
          ({ file, within, call }) => `${file} ${within} ${call}`
        ),
        ["apps/web/src/server/accountDelivery.ts transactor.run sender.send"]
      );

      assert.deepStrictEqual(
        Arr.map(baseline, ({ from, to }) => `${from} -> ${to}`),
        [
          `${d}/shared/outbox.ts -> ${d}/accounts/passwordHasher.ts`,
          `${d}/shared/outbox.ts -> ${d}/workspace/change.ts`,
          `${d}/workspace/commands.ts -> ${d}/jobs/registry.ts`,
          "apps/cms/scripts/checkBundle.ts -> packages/db",
          "apps/cms/scripts/checkBundle.ts -> apps/web",
          "apps/web/test/textSlots.test.ts -> apps/cms",
          "tools/db-path-spike/alchemy.run.ts -> apps/web",
          "tools/oxlint/anti-slop/rules/no-owned-table-write.ts -> packages/db",
        ]
      );
    });
  });
});
