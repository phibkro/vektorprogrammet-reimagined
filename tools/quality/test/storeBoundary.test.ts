import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, Option, Order } from "effect";

import { storeBoundaryProbes } from "../probes.ts";
import { globToRegExp, groupOf } from "../storeBoundary.ts";
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
    (finding) => finding.startsWith(path)
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
    assert.isTrue(
      globToRegExp("apps/web/src/adapters/db/**").test(
        "apps/web/src/adapters/db/a.ts"
      )
    );
    assert.isFalse(
      globToRegExp("apps/web/src/adapters/db/**").test(
        "apps/web/src/adapters/dbx/a.ts"
      )
    );
    assert.isFalse(globToRegExp("a/*.ts").test("a/b/c.ts"));
  });

  it("names each restricted module by group and no other", () => {
    assert.deepStrictEqual(
      groupOf("@vektorprogrammet/db"),
      Option.some("removed-db")
    );

    assert.deepStrictEqual(
      groupOf("@vektorprogrammet/db/testing"),
      Option.some("removed-db")
    );

    assert.deepStrictEqual(
      groupOf("../../apps/web/src/adapters/db/live.ts"),
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
        'import { d } from "../../apps/web/src/adapters/db/live.ts";',
        'export * from "drizzle-orm";',
        'export { e } from "@effect/sql-pg";',
        'export const f = import("pg");',
        "export const g = import(someVariable);",
        'export const h = "import { x } from \\"@vektorprogrammet/db\\"";',
        '// import { y } from "@vektorprogrammet/db"',
        'import { ok } from "../domain/ids.ts";',
      ],
      "\n"
    );

    assert.deepStrictEqual(
      Arr.map(restrictedImports("probe.ts", source), (found) => [
        found.line,
        found.group,
      ]),
      [
        [1, "removed-db"],
        [2, "removed-db"],
        [3, "removed-db"],
        [4, "db"],
        [5, "drizzle"],
        [6, "sql-pg"],
        [7, "pg"],
      ]
    );
  });

  it("resolves relative specifiers into the adapter", () => {
    assert.deepStrictEqual(
      groupsIn("apps/web/src/core/a.ts", "../adapters/db/schema.ts"),
      ["db"]
    );

    assert.deepStrictEqual(
      groupsIn("apps/web/src/core/deep/a.ts", "../../adapters/db/live.ts"),
      ["db"]
    );

    assert.deepStrictEqual(
      groupsIn("apps/web/test/domain/a.ts", "../db/support/x.ts"),
      ["db"]
    );

    // Inside the adapter, a relative import stays in the adapter and is allowed there.
    assert.deepStrictEqual(
      groupsIn("apps/web/src/adapters/db/repositories/a.ts", "../schema.ts"),
      ["db"]
    );

    // A directory that is merely named `db` somewhere else is not the adapter.
    assert.deepStrictEqual(groupsIn("apps/cms/src/a.ts", "../db/index.ts"), []);
    assert.deepStrictEqual(groupsIn("apps/web/src/a.ts", "./db/other.ts"), []);
  });

  describe("findings", () => {
    it("reports an import that no allowance covers", () => {
      const path = "apps/web/src/server/newThing.ts";

      assert.deepStrictEqual(findingsAt(path, "../adapters/db/live.ts", "db"), [
        `${path}:1: imports ../adapters/db/live.ts (db) and no allowance covers it`,
      ]);
    });

    it("reports an allowance that no file needs, so the list only shrinks", () => {
      assert.isTrue(
        Arr.some(
          boundaryFindings(["tools/quality/storeBoundary.ts"], []),
          (finding) =>
            finding.startsWith("apps/web/src/adapters/db/**: allowance")
        )
      );
    });

    it("refuses the removed package even in an allowed adapter", () => {
      const path = "apps/web/src/adapters/db/example.ts";
      assert.deepStrictEqual(
        findingsAt(path, "@vektorprogrammet/db", "removed-db"),
        [
          `${path}:1: imports @vektorprogrammet/db (removed-db), which its allowance does not allow (The adapter and its tests.)`,
        ]
      );
    });

    it("accepts an import that an allowance allows", () => {
      assert.deepStrictEqual(
        findingsAt(
          "tools/db-path-spike/src/worker/database.ts",
          "../../../../apps/web/src/adapters/db/databaseLive.ts",
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
      'import { e } from "../adapters/db/live.ts";',
      'import { f } from "drizzle-orm";',
      'import { g } from "@effect/sql-pg";',
      'import { h } from "pg";',
      'export * from "@vektorprogrammet/db";',
      'export { i } from "@vektorprogrammet/db";',
      'export const j = import("@vektorprogrammet/db/testing");',
    ];

    const everyLine = Arr.map(imports, (_line, index) => index + 1);

    const siblingImports = [
      'import { a } from "../adapters/db/schema.ts";',
      'import { b } from "@/adapters/db/live.ts";',
    ];

    const siblingLines = Arr.map(siblingImports, (_line, index) => index + 1);

    const probes = {
      // An allowance that allows `db`, `pg` and `sql-pg`, but not Drizzle.
      adapterTest: {
        content: text(imports),
        file: storeBoundaryProbes.adapterTest,
      },
      clean: {
        content: text(['import { ok } from "../domain/ids.ts";']),
        file: storeBoundaryProbes.clean,
      },
      // Domain code: no allowance covers it.
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

          // Removed package imports are refused even where adapter access is allowed.
          assert.deepStrictEqual(
            flagged(probes.adapterTest.file),
            [1, 2, 3, 4, 6, 9, 10, 11]
          );

          // Even an adapter-level harness cannot import the removed package.
          assert.deepStrictEqual(
            flagged(probes.harness.file),
            [1, 2, 3, 4, 9, 10, 11]
          );

          // A sibling package reaches the adapter as `../../db/…`, with no `packages/` in the specifier.
          assert.deepStrictEqual(
            flagged(probes.domainSibling.file),
            siblingLines
          );

          assert.deepStrictEqual(flagged(probes.clean.file), []);
        }).pipe(Effect.provide(NodeServices.layer)),
      180_000
    );
  });
});
