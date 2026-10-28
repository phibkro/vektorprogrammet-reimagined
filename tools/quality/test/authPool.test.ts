/**
 * Spec 0017, falsifier 6, read 4: Better Auth's pool is Better Auth's. `apps/web/src/server/auth.ts` hands it to the
 * library (`database: pool`) and to nothing else: no `pool.query`, no `pool.connect`. The restricted role of
 * `auth.postgres.test.ts` catches a read of a domain table, but not a raw read of `auth_user`, a table the role may
 * read; this test is what catches that one (the person-to-identity link is read through `SignInDirectory`).
 */
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, FileSystem } from "effect";
import { Visitor, parseSync } from "oxc-parser";

const authFile = new URL(
  "../../../apps/web/src/server/auth.ts",
  import.meta.url
).pathname;

/** The members read or called on an identifier named `pool`, anywhere in `text`. */
const poolMembers = (text: string): readonly string[] => {
  const found: string[] = [];

  new Visitor({
    MemberExpression(node) {
      if (
        node.object.type === "Identifier" &&
        node.object.name === "pool" &&
        node.property.type === "Identifier"
      ) {
        found.push(node.property.name);
      }
    },
  }).visit(parseSync("auth.ts", text).program);

  return found;
};

describe("Better Auth's pool (spec 0017)", () => {
  it("finds a raw read through the pool, whichever table it names", () => {
    assert.deepStrictEqual(
      poolMembers(
        'pool.query("select email from auth_user where person_id = $1", [id]);'
      ),
      ["query"]
    );

    assert.deepStrictEqual(
      poolMembers("owned.end(); makeAuth(pool, secret);"),
      []
    );
  });

  it.effect("auth.ts uses the pool only as Better Auth's database", () =>
    Effect.gen(function* poolIsBetterAuths() {
      const fs = yield* FileSystem.FileSystem;
      const members = poolMembers(yield* fs.readFileString(authFile));

      assert.deepStrictEqual(Arr.dedupe(members), []);
    }).pipe(Effect.provide(NodeServices.layer))
  );
});
