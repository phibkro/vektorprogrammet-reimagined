/**
 * The privacy check can only be trusted if it can find: these tests plant markers in files of the kind the engine
 * keeps (SQLite, with a WAL beside it) in each way a value can sit there, and read them back with the real scanner.
 */
import { DatabaseSync } from "node:sqlite";

import { assert, layer } from "@effect/vitest";
import { Array as Arr, Effect, Exit, FileSystem, Path } from "effect";

import {
  dumpEngine,
  engineFiles,
  markersInFiles,
  markersInTables,
  rowsOf,
} from "./support/engineStorage.ts";
import { nodeServicesLayer } from "./support/nodeServices.ts";

const TEXT = "Kari Nordmann";
const UTF8_BLOB = "kari.nordmann@person.example";
const UTF16_BLOB = "+47 90000042";
const UTF16_ODD = "Ola Nordmann";
const IN_WAL = "wal-only-secret";
const NEVER = "never-planted";

/** UTF-16, little-endian: the byte order of every platform these tests run on. */
const utf16le = (text: string): Uint8Array =>
  new Uint8Array(
    Uint16Array.from(text, (character) => character.codePointAt(0) ?? 0).buffer
  );

const utf8 = new TextEncoder();

/** A run directory with a plausible engine layout: one instance database, the registry, and a WAL. */
const plantEngine = Effect.fn("test.plantEngine")(function* plantEngine() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "engine-storage-",
  });

  const workflows = path.join(
    directory,
    ".alchemy",
    "local",
    "workflows",
    "Renewal"
  );

  yield* fs.makeDirectory(workflows, { recursive: true });

  const database = new DatabaseSync(path.join(workflows, "instance.sqlite"));

  database.exec("create table states (event text, metadata text)");
  database.exec("create table _cf_KV (key text, value blob)");
  database
    .prepare("insert into states values (?, ?)")
    .run("0", `{"note":"${TEXT}"}`);
  database
    .prepare("insert into _cf_KV values (?, ?)")
    .run("a", utf8.encode(UTF8_BLOB));
  database
    .prepare("insert into _cf_KV values (?, ?)")
    .run("b", utf16le(UTF16_BLOB));
  // Two-byte text that starts on an odd offset of the blob.
  database
    .prepare("insert into _cf_KV values (?, ?)")
    .run("c", Uint8Array.from([0x22, ...utf16le(UTF16_ODD)]));
  database.close();

  // The registry is not an instance; and a WAL holds bytes that no table query shows.
  new DatabaseSync(path.join(workflows, "metadata.sqlite")).close();
  yield* fs.writeFile(
    path.join(workflows, "instance.sqlite-wal"),
    utf8.encode(IN_WAL)
  );

  return directory;
});

layer(nodeServicesLayer)("the engine storage scanner", (it) => {
  it.effect(
    "reads the tables of the instance databases and skips the registry",
    () =>
      Effect.gen(function* readsTables() {
        const directory = yield* plantEngine();
        const files = yield* engineFiles(directory);

        assert.strictEqual(files.length, 1);
        assert.isTrue((files[0] ?? "").endsWith("instance.sqlite"));

        const dumps = yield* dumpEngine(directory);

        assert.deepStrictEqual(
          Arr.map(rowsOf(dumps, "states"), (row) => row.event),
          ["0"]
        );
      })
  );

  it.effect(
    "finds a marker in a text cell and in a blob as UTF-8 or UTF-16, whatever its alignment",
    () =>
      Effect.gen(function* findsInTables() {
        const dumps = yield* dumpEngine(yield* plantEngine());

        assert.deepStrictEqual(
          markersInTables(dumps, [
            TEXT,
            UTF8_BLOB,
            UTF16_BLOB,
            UTF16_ODD,
            NEVER,
          ]),
          [TEXT, UTF8_BLOB, UTF16_BLOB, UTF16_ODD]
        );
      })
  );

  it.effect(
    "finds a marker in the raw bytes of any file, a WAL included, and none that was not planted",
    () =>
      Effect.gen(function* findsInFiles() {
        const directory = yield* plantEngine();

        assert.deepStrictEqual(
          yield* markersInFiles(directory, [
            TEXT,
            UTF8_BLOB,
            UTF16_BLOB,
            UTF16_ODD,
            IN_WAL,
            NEVER,
          ]),
          [TEXT, UTF8_BLOB, UTF16_BLOB, UTF16_ODD, IN_WAL]
        );
      })
  );

  it.effect(
    "dies, rather than passing, when the engine has no storage at all",
    () =>
      Effect.gen(function* failsLoudly() {
        const fs = yield* FileSystem.FileSystem;

        const empty = yield* fs.makeTempDirectoryScoped({
          prefix: "engine-storage-empty-",
        });

        assert.isTrue(Exit.isFailure(yield* Effect.exit(dumpEngine(empty))));
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(markersInFiles(empty, [TEXT])))
        );
      })
  );
});
