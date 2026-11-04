/**
 * Spec 0025, falsifiers 4 and 5: the constructs of this adapter are independent of advisory locks, and Hyperdrive's subset
 * is distinct from what a direct connection has.
 *
 * - The statement classifier finds every direct-only construct in a planted text, finds none of them in the constructs the
 *   adapter uses, and does not read comments or quoted text (its controls are the allowed constructs and the quoted words).
 * - The recipes are typed `PooledSafeConstruct` (a type test), every capability has one, and every construct that a recipe
 *   names is one that Hyperdrive leaves alone (`works` or `scoped`).
 * - `hyperdrive.allows` is a strict subset of `direct.allows`, and the difference is `directOnly`, each with an outcome on
 *   Hyperdrive that is not `works`.
 * - The real tree: the SQL in `packages/db/src`, `apps/web/src` and the migrations uses no direct-only construct.
 */
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Capability } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Record as Rec } from "effect";
import { expectTypeOf } from "vite-plus/test";

import {
  DirectOnlyConstructs,
  PooledSafeConstructs,
  constructFacts,
} from "../src/platform/constructs.ts";
import type {
  DirectOnlyConstruct,
  PooledSafeConstruct,
} from "../src/platform/constructs.ts";
import { evidence } from "../src/platform/evidence.ts";
import { direct, directOnly, hyperdrive } from "../src/platform/profiles.ts";
import { recipes } from "../src/platform/recipes.ts";
import type { Recipe } from "../src/platform/recipes.ts";
import {
  constructsOf,
  forbiddenConstructsOf,
  sqlWords,
} from "../src/platform/statements.ts";
import { sourcesOfTheAdapter } from "./support/platformSources.ts";
import { findingsIn, textsIn } from "./support/sqlLiterals.ts";

/** One planted statement for each direct-only construct, and the construct it must be found as. */
const planted: readonly (readonly [DirectOnlyConstruct, string])[] = [
  ["advisory-lock-session", "select pg_advisory_lock(42)"],
  ["advisory-lock-session", "SELECT pg_try_advisory_lock($1)"],
  ["advisory-lock-session", "select pg_advisory_unlock_all()"],
  ["advisory-lock-transaction", "select pg_advisory_xact_lock(1, 2)"],
  ["advisory-lock-transaction", "select pg_try_advisory_xact_lock_shared(1)"],
  ["listen", "LISTEN outbox"],
  ["listen", "begin; unlisten *"],
  ["notify", "NOTIFY outbox, 'x'"],
  ["notify", "select pg_notify('outbox', 'x')"],
  ["set-session", "SET search_path = public"],
  ["set-session", "set session authorization default"],
  ["set-session", "RESET ALL"],
  ["set-session", "select set_config('app.person', '1', false)"],
  ["set-session", "select set_config('app.person', $1, $2)"],
  ["sql-prepare", "PREPARE p AS select 1"],
  ["sql-prepare", "EXECUTE p"],
  ["sql-prepare", "deallocate all"],
  ["sql-prepare", "DISCARD ALL"],
  ["with-hold-cursor", "declare c cursor with hold for select 1"],
  ["temporary-table", "create temp table t (a int)"],
  ["temporary-table", "CREATE TEMPORARY TABLE t (a int) on commit drop"],
  ["load", "load 'auto_explain'"],
];

/** The constructs that the adapter uses, written as it writes them: none may be found as a direct-only one. */
const allowed: readonly (readonly [PooledSafeConstruct, string])[] = [
  ["transaction-block", "BEGIN"],
  ["begin-isolation-level", "BEGIN ISOLATION LEVEL READ COMMITTED"],
  ["savepoint", "SAVEPOINT level_1"],
  ["savepoint", "rollback to savepoint level_1"],
  ["row-lock", "select id from person order by id for no key update"],
  ["row-lock-nowait", "select 1 from admin_list for update nowait"],
  ["row-lock-skip-locked", "select id from outbox for update skip locked"],
  [
    "on-conflict-returning",
    "insert into t values ($1) on conflict do nothing returning id",
  ],
  ["unique-constraint", "alter table t add constraint k unique (a)"],
  ["exclusion-constraint", "alter table t add exclude using gist (a with &&)"],
  ["set-local", "SET LOCAL statement_timeout = '5s'"],
  ["set-local", "select set_config('app.person', $1, true)"],
];

describe("spec 0025 F4: the statement classifier", () => {
  it("every planted direct-only construct is found as itself", () => {
    for (const [construct, sql] of planted) {
      assert.include(constructsOf(sql), construct, sql);
    }
  });

  it("control: the constructs that the adapter uses are found as themselves and never as a direct-only one", () => {
    for (const [construct, sql] of allowed) {
      assert.include(constructsOf(sql), construct, sql);
      assert.deepStrictEqual(forbiddenConstructsOf(sql), [], sql);
    }
  });

  it("control: words in comments and in quoted text are not constructs", () => {
    const disguised = [
      "select 1 -- pg_advisory_lock(1) and LISTEN x",
      "select 1 /* set search_path = x; pg_notify('a', 'b') */",
      "select 'pg_advisory_lock(1)' as a, 'listen' as b",
      "select 'it''s a set_config(a, b, false)'",
      'select "pg_advisory_lock" from t',
      "select $$ listen x; prepare y $$",
      "select $body$ discard all $body$",
      "select E'a\\'s pg_advisory_lock(1)'",
      "update t set a = 1",
      "select a from t where name = 'set'",
    ];

    for (const sql of disguised) {
      assert.deepStrictEqual(forbiddenConstructsOf(sql), [], sql);
    }
  });

  it("`sqlWords` keeps the places and drops the words", () => {
    assert.strictEqual(
      sqlWords("SELECT 'a b' , \"Q\" -- x\n FROM /* y */ t"),
      "select '' , \"i\" from t"
    );
  });
});

describe("spec 0025 F4 and F5: the constructs, the subsets and the recipes", () => {
  it("the two sets are disjoint, and every construct has a fact", () => {
    const all = [...PooledSafeConstructs, ...DirectOnlyConstructs];
    assert.strictEqual(new Set(all).size, all.length);
    assert.sameMembers(Rec.keys(constructFacts), all);
  });

  it("F5: hyperdrive allows a strict subset of what direct allows, and the difference is `directOnly`", () => {
    assert.sameMembers([...hyperdrive.allows], [...PooledSafeConstructs]);

    assert.sameMembers(
      [...direct.allows],
      [...PooledSafeConstructs, ...DirectOnlyConstructs]
    );

    assert.sameMembers(Arr.difference(direct.allows, hyperdrive.allows), [
      ...directOnly,
    ]);

    assert.isBelow(hyperdrive.allows.length, direct.allows.length);
  });

  it("F5: no direct-only construct works on Hyperdrive, and each says how it is known", () => {
    for (const construct of DirectOnlyConstructs) {
      const { hyperdrive: cell } = constructFacts[construct];
      assert.notStrictEqual(cell.outcome, "works", construct);
      assert.isAbove(cell.note.length, 10, construct);
    }
  });

  it("the adapter says where every capability is shown, and says so when it is not measured through Hyperdrive", () => {
    assert.sameMembers(Rec.keys(evidence), [...Capability.literals]);

    for (const [capability, text] of Rec.toEntries(evidence)) {
      assert.isAbove(text.length, 20, capability);
    }
  });

  it("F4: every capability has a recipe, and every construct of a recipe is one that Hyperdrive leaves alone", () => {
    assert.sameMembers(Rec.keys(recipes), [...Capability.literals]);

    for (const [capability, recipe] of Rec.toEntries(recipes)) {
      for (const construct of recipe) {
        const { outcome } = constructFacts[construct].hyperdrive;
        assert.include(
          ["works", "scoped"],
          outcome,
          `${capability}: ${construct}`
        );
      }
    }
  });

  it("F4: a recipe takes pooled-safe constructs only (a type: an advisory lock does not fit)", () => {
    expectTypeOf<Recipe>().toEqualTypeOf<readonly PooledSafeConstruct[]>();
    expectTypeOf<"advisory-lock-session">().not.toExtend<PooledSafeConstruct>();
    expectTypeOf<DirectOnlyConstruct>().not.toExtend<PooledSafeConstruct>();
    expectTypeOf(hyperdrive.allows).toExtend<readonly PooledSafeConstruct[]>();
  });

  it.effect(
    "F4 on the real tree: the string and template literals of the adapter, the Worker and the migrations use no direct-only construct",
    () =>
      Effect.gen(function* theRealTree() {
        const sources = yield* sourcesOfTheAdapter;
        assert.isAbove(sources.length, 50, "the scan found the tree");

        assert.deepStrictEqual(
          Arr.flatMap(sources, ({ path, source }) => findingsIn(path, source)),
          []
        );

        // The scan saw statements at all: the adapter's own are in it, handed over as tagged templates and as calls.
        const seen = Arr.flatMap(sources, ({ path, source }) =>
          path.endsWith(".sql")
            ? []
            : Arr.filter(textsIn(path, source), ({ statement }) => statement)
        );

        assert.isAbove(seen.length, 100);
      }).pipe(Effect.provide(NodeServices.layer))
  );

  /** The reviewer's four: each was a statement that the first version of the scan did not read. */
  it("F4 control: a planted construct is found in a plain constant, a call, a renamed tag and a template, with its line and its catalogue row", () => {
    const source = Arr.join(
      [
        "const a = 1;",
        'const plain = "select pg_advisory_lock(42)";',
        'const viaPool = pool.query("select pg_try_advisory_lock($1)");',
        "const viaTag = db`select pg_advisory_xact_lock(1)`;",
        'const viaExec = client.exec("listen outbox");',
        "const viaNew = new Query(`set search_path = x`);",
        "const fine = sql`select id from t for no key update`;",
      ],
      "\n"
    );

    assert.deepStrictEqual(
      Arr.map(findingsIn("planted.ts", source), (finding) =>
        finding.replace(/ \(.*$/u, "")
      ),
      [
        "planted.ts:2: advisory-lock-session",
        "planted.ts:3: advisory-lock-session",
        "planted.ts:4: advisory-lock-transaction",
        "planted.ts:5: listen",
        "planted.ts:6: set-session",
      ]
    );

    assert.include(
      findingsIn("planted.ts", 'const q = client.exec("listen outbox");')[0],
      "pg-txmode row: listen"
    );

    assert.include(
      findingsIn("planted.ts", 'const q = "select pg_advisory_lock(1)";')[0],
      "Hyperdrive: unsupported, hyperdrive-docs"
    );
  });

  it("F4 control: an opening word in a sentence of a constant is not a construct, and in a statement it is", () => {
    const prose = [
      'const label = "Listen to the list";',
      'const note = "set the table";',
      'const text = "prepare the room, load the van, notify the team";',
    ];

    assert.deepStrictEqual(findingsIn("prose.ts", Arr.join(prose, "\n")), []);
    assert.lengthOf(findingsIn("call.ts", 'db.run("listen outbox");'), 1);
  });
});
