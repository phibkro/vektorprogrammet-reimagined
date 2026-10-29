import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, Option, Order, String as Str } from "effect";

import { storeBoundaryProbes } from "../probes.ts";
import { allowances, globToRegExp, groupOf } from "../storeBoundary.ts";
import {
  boundaryFindings,
  restrictedImports,
  scanRepository,
} from "../storeBoundaryCheck.ts";
import type { ImportSite } from "../storeBoundaryCheck.ts";
import { lintProbes } from "./support/lintProbes.ts";

const root = new URL("../../../", import.meta.url).pathname;

const site = (
  path: string,
  specifier: string,
  group: ImportSite["group"]
): ImportSite => ({ group, line: 1, path, specifier });

const text = (lines: readonly string[]) => `${Arr.join(lines, "\n")}\n`;

const findingsAt = (
  path: string,
  specifier: string,
  group: ImportSite["group"]
) =>
  Arr.filter(
    boundaryFindings([path], [site(path, specifier, group)]),
    (finding) => Str.startsWith(path)(finding)
  );

const groupsIn = (path: string, specifier: string) =>
  Arr.map(
    restrictedImports(path, `import { x } from "${specifier}";\n`),
    (found) => found.group
  );

describe("store boundary (spec 0017, ADR 0014 stage 1)", () => {
  it("a glob's `**` crosses directories (also none) and its `*` stops at a slash", () => {
    const tests = globToRegExp("apps/web/test/**/*.postgres.test.ts");

    assert.isTrue(tests.test("apps/web/test/auth.postgres.test.ts"));
    assert.isTrue(tests.test("apps/web/test/deep/er/auth.postgres.test.ts"));
    assert.isFalse(tests.test("apps/web/test/auth.test.ts"));
    assert.isFalse(tests.test("apps/web/src/auth.postgres.test.ts"));
    assert.isTrue(globToRegExp("packages/db/**").test("packages/db/src/a.ts"));
    assert.isFalse(globToRegExp("packages/db/**").test("packages/dbx/a.ts"));
    assert.isFalse(globToRegExp("a/*.ts").test("a/b/c.ts"));
  });

  it("names each restricted module by group and no other", () => {
    assert.deepStrictEqual(groupOf("@vektorprogrammet/db"), Option.some("db"));

    assert.deepStrictEqual(
      groupOf("@vektorprogrammet/db/testing"),
      Option.some("db")
    );

    assert.deepStrictEqual(
      groupOf("../../packages/db/src/index.ts"),
      Option.some("db")
    );

    assert.deepStrictEqual(
      groupOf("drizzle-orm/effect-postgres"),
      Option.some("drizzle")
    );

    assert.deepStrictEqual(groupOf("@effect/sql-pg"), Option.some("sql-pg"));
    assert.deepStrictEqual(
      groupOf("@effect/sql-pglite"),
      Option.some("sql-pg")
    );
    assert.deepStrictEqual(groupOf("pg"), Option.some("pg"));

    assert.deepStrictEqual(groupOf("@vektorprogrammet/domain"), Option.none());

    assert.deepStrictEqual(
      groupOf("@vektorprogrammet/db-path-spike"),
      Option.none()
    );

    assert.deepStrictEqual(groupOf("@effect/sql-mysql2"), Option.none());
    assert.deepStrictEqual(groupOf("pgvector"), Option.none());
    assert.deepStrictEqual(groupOf("../db/other"), Option.none());
  });

  it("finds every import form and skips text that only mentions a package", () => {
    const source = Arr.join(
      [
        'import { a } from "@vektorprogrammet/db";',
        'import type { B } from "@vektorprogrammet/db";',
        'import * as c from "@vektorprogrammet/db/testing";',
        'import { d } from "../../packages/db/src/index.ts";',
        'export * from "drizzle-orm";',
        'export { e } from "@effect/sql-pg";',
        'export const f = import("pg");',
        "export const g = import(someVariable);",
        'export const h = "import { x } from \\"@vektorprogrammet/db\\"";',
        '// import { y } from "@vektorprogrammet/db"',
        'import { ok } from "@vektorprogrammet/domain";',
      ],
      "\n"
    );

    assert.deepStrictEqual(
      Arr.map(restrictedImports("probe.ts", source), (found) => [
        found.line,
        found.group,
      ]),
      [
        [1, "db"],
        [2, "db"],
        [3, "db"],
        [4, "db"],
        [5, "drizzle"],
        [6, "sql-pg"],
        [7, "pg"],
      ]
    );
  });

  it("resolves a relative specifier against the importing file, so a sibling package's `../../db` is the adapter", () => {
    assert.deepStrictEqual(
      groupsIn("packages/domain/src/a.ts", "../../db/src/schema.ts"),
      ["db"]
    );

    assert.deepStrictEqual(
      groupsIn("packages/cms-client/src/deep/a.ts", "../../../db/src/index.ts"),
      ["db"]
    );

    assert.deepStrictEqual(
      groupsIn("packages/domain/test/a.ts", "../../db/test/support/x.ts"),
      ["db"]
    );

    // Inside the adapter, a relative import stays in the adapter and is allowed there.
    assert.deepStrictEqual(
      groupsIn("packages/db/src/repositories/a.ts", "../schema.ts"),
      ["db"]
    );

    // A directory that is merely named `db` somewhere else is not the adapter.
    assert.deepStrictEqual(groupsIn("apps/cms/src/a.ts", "../db/index.ts"), []);
    assert.deepStrictEqual(groupsIn("apps/web/src/a.ts", "./db/other.ts"), []);
  });

  describe("findings", () => {
    it("reports an import that no allowance covers", () => {
      const path = "apps/web/src/server/newThing.ts";

      assert.deepStrictEqual(findingsAt(path, "@vektorprogrammet/db", "db"), [
        `${path}:1: imports @vektorprogrammet/db (db) and no allowance covers it`,
      ]);
    });

    it("reports a group that the covering allowance does not allow", () => {
      const path = "apps/web/src/server/auth.ts";

      assert.deepStrictEqual(
        Arr.filter(
          boundaryFindings([path], [site(path, "drizzle-orm", "drizzle")]),
          (finding) => Str.includes("does not allow")(finding)
        ),
        [
          `${path}:1: imports drizzle-orm (drizzle), which its allowance does not allow (Better Auth's own \`pg\` adapter (ADR 0014, answer 4; exception EX-0017). It reads no domain table.)`,
        ]
      );
    });

    it("reports an allowance that no file needs, so the list only shrinks", () => {
      assert.isTrue(
        Arr.some(
          boundaryFindings(["tools/quality/storeBoundary.ts"], []),
          (finding) => Str.startsWith("packages/db/**: allowance")(finding)
        )
      );
    });

    it("accepts an import that an allowance allows", () => {
      assert.deepStrictEqual(
        findingsAt(
          "tools/db-path-spike/src/worker/database.ts",
          "@vektorprogrammet/db",
          "db"
        ),
        []
      );
    });
  });

  it.effect(
    "every restricted import in the repository is covered, and every allowance is needed",
    () =>
      Effect.gen(function* repositoryIsClean() {
        const { paths, sites } = yield* scanRepository(root);

        assert.deepStrictEqual(boundaryFindings(paths, sites), []);
      }).pipe(Effect.provide(NodeServices.layer)),
    120_000
  );

  it("the end state: outside packages/db, only the composition roots and Better Auth's adapter hold a production allowance", () => {
    const production = Arr.flatMap(allowances, (allowance) =>
      Arr.filter(
        allowance.files,
        (glob) =>
          Str.includes("/src/")(glob) && !Str.startsWith("packages/db/")(glob)
      )
    );

    assert.deepStrictEqual(Arr.sort(production, Order.String), [
      "apps/web/src/server/auth.ts",
      "apps/web/src/server/runtime.ts",
      "tools/import/src/pipeline.ts",
    ]);
  });

  /**
   * The real configuration, through `vp lint`: probe files are written where the rule must fail and where it must
   * not, linted once, and removed again. Vitest runs the tests of a file in order, so the repository scan above never
   * sees a probe.
   */
  describe("the lint", () => {
    const imports = [
      'import { a } from "@vektorprogrammet/db";',
      'import type { B } from "@vektorprogrammet/db";',
      'import * as c from "@vektorprogrammet/db";',
      'import { d } from "@vektorprogrammet/db/testing";',
      'import { e } from "../../../packages/db/test/support/disposableDatabase.ts";',
      'import { f } from "drizzle-orm";',
      'import { g } from "@effect/sql-pg";',
      'import { h } from "pg";',
      'export * from "@vektorprogrammet/db";',
      'export { i } from "@vektorprogrammet/db";',
      'export const j = import("@vektorprogrammet/db/testing");',
    ];

    const everyLine = Arr.map(imports, (_line, index) => index + 1);

    const siblingImports = [
      'import { a } from "../../db/src/schema.ts";',
      'import { b } from "../../db/test/support/disposableDatabase.ts";',
    ];

    const siblingLines = Arr.map(siblingImports, (_line, index) => index + 1);

    const probes = {
      // An allowance that allows `db`, `pg` and `sql-pg`, but not Drizzle.
      adapterTest: {
        content: text(imports),
        file: storeBoundaryProbes.adapterTest,
      },
      clean: {
        content: text(['import { ok } from "@vektorprogrammet/domain";']),
        file: storeBoundaryProbes.clean,
      },
      // Packages beside `packages/db`: no allowance covers them.
      cmsClientSibling: {
        content: text(siblingImports),
        file: storeBoundaryProbes.cmsClientSibling,
      },
      domainSibling: {
        content: text(siblingImports),
        file: storeBoundaryProbes.domainSibling,
      },
      // An allowance of every group.
      harness: {
        content: text(imports),
        file: storeBoundaryProbes.harness,
      },
      // No allowance covers it.
      restricted: {
        content: text(imports),
        file: storeBoundaryProbes.restricted,
      },
    } as const;

    it.effect(
      "fails every form outside an allowed path, and only the group that an allowance leaves out inside one",
      () =>
        Effect.gen(function* probesAreLinted() {
          const diagnostics = yield* lintProbes(root, probes);

          const flagged = (file: string): readonly number[] =>
            Arr.sort(
              Arr.dedupe(
                Arr.flatMap(diagnostics, (item) =>
                  item.filename === file &&
                  item.code === "eslint(no-restricted-imports)"
                    ? item.lines
                    : []
                )
              ),
              Order.Number
            );

          // Outside every allowance: each of the eleven forms fails.
          assert.deepStrictEqual(flagged(probes.restricted.file), everyLine);

          // Inside an allowance that leaves Drizzle out: only the Drizzle line (6) fails.
          assert.deepStrictEqual(flagged(probes.adapterTest.file), [6]);

          // Inside an allowance of every group, and with nothing restricted imported: nothing fails.
          assert.deepStrictEqual(flagged(probes.harness.file), []);

          // A sibling package reaches the adapter as `../../db/…`, with no `packages/` in the specifier.
          assert.deepStrictEqual(
            flagged(probes.domainSibling.file),
            siblingLines
          );

          assert.deepStrictEqual(
            flagged(probes.cmsClientSibling.file),
            siblingLines
          );
          assert.deepStrictEqual(flagged(probes.clean.file), []);
        }).pipe(Effect.provide(NodeServices.layer)),
      180_000
    );
  });
});
