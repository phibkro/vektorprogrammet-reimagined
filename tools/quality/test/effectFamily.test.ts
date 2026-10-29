import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect, FileSystem, Option, Path, Schema } from "effect";

import { effectFamilyDrift, tsgoPinDrift } from "../effectFamily.ts";
import type { TsgoPin } from "../effectFamily.ts";

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

const Manifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Manifest)
);

/** The `@effect/tsgo` pin that a `package.json` text declares, if it does. */
const pinOf = (file: string, text: string) =>
  Effect.map(decodeManifest(text), (manifest): readonly TsgoPin[] => {
    const version =
      manifest.devDependencies?.["@effect/tsgo"] ??
      manifest.dependencies?.["@effect/tsgo"];

    return version === undefined ? [] : [{ file, version }];
  });

describe("one @effect/tsgo feeds the lint of every workspace package", () => {
  it("a package that pins another version is reported by file and version", () => {
    assert.deepStrictEqual(
      tsgoPinDrift({ file: "package.json", version: "0.63.0" }, [
        { file: "package.json", version: "0.63.0" },
        { file: "tools/quality/package.json", version: "0.53.1" },
      ]),
      [
        "tools/quality/package.json pins @effect/tsgo 0.53.1, package.json pins 0.63.0",
      ]
    );
  });

  it.effect(
    "the root and every workspace package pin the same version, and the lock's own entry is that version",
    () =>
      Effect.gen(function* workspacePins() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const repository = yield* path.fromFileUrl(
          new URL("../../../", import.meta.url)
        );

        const files = ["package.json"];

        const workspaces = Arr.flatten(
          yield* Effect.forEach(["apps", "packages", "tools"], (group) =>
            Effect.map(
              Effect.option(fs.readDirectory(path.join(repository, group))),
              (names) =>
                Arr.map(
                  Option.getOrElse(names, (): string[] => []),
                  (name) => `${group}/${name}/package.json`
                )
            )
          )
        );

        const pins = Arr.flatten(
          yield* Effect.forEach([...files, ...workspaces], (file) =>
            Effect.flatMap(
              Effect.option(fs.readFileString(path.join(repository, file))),
              Option.match({
                onNone: () => Effect.succeed<readonly TsgoPin[]>([]),
                onSome: (text) => pinOf(file, text),
              })
            )
          )
        );

        const root = Arr.findFirst(pins, ({ file }) => file === "package.json");
        assert.isTrue(Option.isSome(root));

        if (Option.isNone(root)) {
          return;
        }

        assert.isAbove(pins.length, 1);
        assert.deepStrictEqual(tsgoPinDrift(root.value, pins), []);

        // The lock's own entry (not the copy that `@phibkro/oxlint-effect-plugin` brings for itself) is the root's pin.
        const lock = yield* readLock;

        assert.include(
          lock,
          `"@effect/tsgo": ["@effect/tsgo@${root.value.version}",`
        );
      }).pipe(Effect.provide(NodeServices.layer))
  );
});
