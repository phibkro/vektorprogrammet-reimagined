/**
 * Spec 0017, falsifier 6, read 4: Better Auth's pool is Better Auth's. `apps/web/src/server/auth.ts` hands it to the
 * library (`database: pool`) and to nothing else: it runs no SQL of its own through it. The restricted role of
 * `auth.postgres.test.ts` catches a read of a domain table, but not a raw read of `auth_user`, a table the role may
 * read; this test is what catches that one (the person-to-identity link is read through `SignInDirectory`).
 *
 * The test follows the methods that run SQL (`query`, `connect`), not the name of one binding: the pool is bound as
 * `pool` and, in its finalizer, as `owned`, and an alias, a destructured method or a quoted key would run the same SQL.
 * Neither `auth.ts` nor the code around the pool has any use for a member or a key of those names. A key built at run
 * time (`pool[name]`) is the one spelling that this test cannot follow.
 */
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, FileSystem, String as Str } from "effect";
import { Visitor, parseSync } from "oxc-parser";

const authFile = new URL(
  "../../../apps/web/src/server/auth.ts",
  import.meta.url
).pathname;

const sqlMethods = new Set(["query", "connect"]);

/** The SQL-running methods that `text` names as a member (`x.query`, `x["query"]`) or as a destructured key. */
const sqlMethodUses = (text: string): readonly string[] => {
  const found: string[] = [];

  // A key as written, without the quotes of `x["query"]` or `{ "query": q }`.
  const keyAt = (key: { readonly start: number; readonly end: number }) =>
    Str.replaceAll(/["'`]/gu, "")(Str.slice(key.start, key.end)(text));

  const note = (name: string) => {
    if (sqlMethods.has(name)) {
      found.push(name);
    }
  };

  new Visitor({
    MemberExpression(node) {
      note(keyAt(node.property));
    },
    ObjectPattern(node) {
      for (const property of node.properties) {
        if (property.type === "Property") {
          note(keyAt(property.key));
        }
      }
    },
  }).visit(parseSync("auth.ts", text).program);

  return found;
};

describe("Better Auth's pool (spec 0017)", () => {
  it("finds a raw read through the pool, whatever the pool is called and however the method is spelled", () => {
    assert.deepStrictEqual(
      sqlMethodUses(
        'pool.query("select email from auth_user where person_id = $1", [id]);'
      ),
      ["query"]
    );

    assert.deepStrictEqual(sqlMethodUses("owned.query(sql);"), ["query"]);
    assert.deepStrictEqual(sqlMethodUses("const p = pool; p.connect();"), [
      "connect",
    ]);

    assert.deepStrictEqual(sqlMethodUses("const { query } = pool;"), ["query"]);
    assert.deepStrictEqual(sqlMethodUses('pool["query"](sql);'), ["query"]);
    assert.deepStrictEqual(sqlMethodUses("owned.end(); makeAuth(pool);"), []);
  });

  it.effect("auth.ts uses the pool only as Better Auth's database", () =>
    Effect.gen(function* poolIsBetterAuths() {
      const fs = yield* FileSystem.FileSystem;
      const uses = sqlMethodUses(yield* fs.readFileString(authFile));

      assert.deepStrictEqual(Arr.dedupe(uses), []);
    }).pipe(Effect.provide(NodeServices.layer))
  );
});
