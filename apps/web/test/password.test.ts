/** Spec 0007 falsifier 1. The $2y$ fixture was produced by PHP 8.4 password_hash at cost 12. */
import { assert, describe, it } from "@effect/vitest";
import { verifyPassword as defaultVerifier } from "better-auth/crypto";
import { Effect, Exit, String as Str } from "effect";

import { hashPassword, verifyPassword } from "../src/server/password";
import {
  bcryptFixtures as fixtures,
  fixturePassword as password,
} from "./support/passwordFixtures";

const verifies = (hash: string, value: string) =>
  Effect.promise(() => verifyPassword({ hash, password: value }));

describe("RULE-024, 126, 166: Worker-compatible bcrypt", () => {
  it.effect(
    "verifies PHP and both bcrypt variants without accepting wrong passwords",
    () =>
      Effect.gen(function* fixtureChecks() {
        for (const fixture of fixtures) {
          assert.isTrue(yield* verifies(fixture, password));
          assert.isFalse(yield* verifies(fixture, "wrong password"));
        }
      })
  );

  it.effect(
    "refuses truncated hashes and passwords bcrypt would truncate",
    () =>
      Effect.gen(function* truncationChecks() {
        assert.isFalse(
          yield* verifies(Str.slice(0, -1)(fixtures[0]), password)
        );
        assert.isFalse(yield* verifies(fixtures[0], Str.repeat(73)("a")));
        assert.isFalse(yield* verifies(fixtures[0], Str.repeat(37)("ø")));

        const rejected = yield* Effect.exit(
          Effect.tryPromise(() => hashPassword(Str.repeat(73)("a")))
        );

        assert.isTrue(Exit.isFailure(rejected));
      })
  );

  it.effect("new hashes use cost 12 and verify", () =>
    Effect.gen(function* newHashCheck() {
      const hash = yield* Effect.promise(() => hashPassword(password));
      assert.match(hash, /^\$2[ab]\$12\$/u);
      assert.isTrue(yield* verifies(hash, password));
    })
  );

  it.effect(
    "negative control: Better Auth's default verifier rejects PHP bcrypt",
    () =>
      Effect.gen(function* defaultVerifierCheck() {
        const result = yield* Effect.exit(
          Effect.tryPromise(() =>
            defaultVerifier({ hash: fixtures[0], password })
          )
        );

        assert.isTrue(Exit.isFailure(result));
      })
  );
});
