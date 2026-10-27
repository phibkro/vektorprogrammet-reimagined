import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { effectFamilyDrift } from "../effectFamily.ts";

const readLock = Effect.gen(function* readLock() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* fs.readFileString(
    yield* path.fromFileUrl(new URL("../../../bun.lock", import.meta.url))
  );
});

const entry = (name: string, version: string) =>
  `    "${name}": ["${name}@${version}", "", {}, "sha512-x"],\n`;

describe("Effect family versions", () => {
  it.effect("every @effect/* package in bun.lock is the effect version", () =>
    Effect.gen(function* aligned() {
      assert.deepStrictEqual(effectFamilyDrift(yield* readLock), []);
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "a family package behind effect is reported by name and version",
    () =>
      Effect.gen(function* probe() {
        const lock = yield* readLock;
        const behind = `${lock}${entry("@effect/probe", "4.0.0")}`;

        assert.deepStrictEqual(effectFamilyDrift(behind), [
          `@effect/probe is locked at 4.0.0, effect at ${/"effect@(?<version>[^"]+)"/u.exec(lock)?.groups?.version}`,
        ]);
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it("names a nested family package by what it is, not by its path", () => {
    const lock = `${entry("effect", "4.0.6")}    "host/@effect/sql-pg": ["@effect/sql-pg@4.0.5", "", {}, "x"],\n`;

    assert.deepStrictEqual(effectFamilyDrift(lock), [
      "@effect/sql-pg is locked at 4.0.5, effect at 4.0.6",
    ]);
  });

  it("leaves @effect/tsgo and its binaries on their own release line", () => {
    const lock = `${entry("effect", "4.0.6")}${entry("@effect/tsgo", "0.53.1")}${entry("@effect/tsgo-linux-x64", "0.53.1")}`;

    assert.deepStrictEqual(effectFamilyDrift(lock), []);
  });

  it("fails when effect itself is locked twice or not at all", () => {
    assert.lengthOf(
      effectFamilyDrift(
        `${entry("effect", "4.0.5")}${entry("effect", "4.0.6")}`
      ),
      1
    );
    assert.lengthOf(effectFamilyDrift(entry("@effect/sql-pg", "4.0.6")), 1);
  });
});
