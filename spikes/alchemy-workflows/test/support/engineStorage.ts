/**
 * What the local workflow engine keeps on disk, read for the privacy check.
 *
 * The engine is a Durable Object per instance, and workerd stores a Durable Object's data in a SQLite file under
 * `<directory alchemy dev runs in>/.alchemy/local/workflows/<workflow>/`. The `states` table holds the event log (the
 * instance parameters, every step's output and error, the outcome as JSON), `_cf_KV` the engine's key-value data as
 * serialized blobs. This module reads those files without touching the engine, and finds personal data in them two
 * ways: in every cell of every table (text as it is, a blob as Latin-1, UTF-8 and UTF-16), and in the raw bytes of
 * every file, WAL included, so a value that no table query shows still counts.
 */
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";

import { Array as Arr, Effect, FileSystem, Path, Record } from "effect";

import { EngineStorageUnreadable } from "./errors.ts";

/** One row of an engine table: every cell as text. */
export type EngineRow = Readonly<Record<string, string>>;

export interface EngineTable {
  readonly name: string;
  /** Every searchable rendering of every cell of the table, for `markersInTables`. */
  readonly renderings: readonly string[];
  /** The rows, each cell as text (a blob as Latin-1, so the ASCII of a serialized value stays readable). */
  readonly rows: readonly EngineRow[];
}

export interface EngineDatabase {
  readonly file: string;
  readonly tables: readonly EngineTable[];
}

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");
const utf16 = new TextDecoder("utf-16le");

/**
 * Every way that text can sit in bytes: one byte per character, UTF-8, and UTF-16 at either alignment (a serialized
 * value need not start at an even offset, and a two-byte string in the middle of it could begin on an odd one).
 */
export const renderingsOfBytes = (bytes: Uint8Array): readonly string[] => [
  latin1.decode(bytes),
  utf8.decode(bytes),
  utf16.decode(bytes),
  utf16.decode(bytes.subarray(1)),
];

const renderings = (cell: SQLOutputValue): readonly string[] =>
  cell instanceof Uint8Array ? renderingsOfBytes(cell) : [String(cell)];

const asText = (cell: SQLOutputValue): string =>
  cell instanceof Uint8Array ? latin1.decode(cell) : String(cell);

const dumpDatabase = (file: string): EngineDatabase => {
  const database = new DatabaseSync(file, { readOnly: true });

  try {
    const names = database
      .prepare("select name from sqlite_master where type = 'table'")
      .all();

    return {
      file,
      tables: Arr.map(names, (entry) => {
        const name = String(entry.name);
        const raw = database.prepare(`select * from "${name}"`).all();

        return {
          name,
          renderings: Arr.flatMap(raw, (row) =>
            Arr.flatMap(Record.values(row), renderings)
          ),
          rows: Arr.map(raw, (row) => Record.map(row, asText)),
        };
      }),
    };
  } finally {
    database.close();
  }
};

/** The SQLite files of the engine (not the registry's `metadata.sqlite`) under a run directory's local storage. */
export const engineFiles = Effect.fn("engineStorage.files")(
  function* engineFiles(directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const entries = yield* fs
      .readDirectory(path.join(directory, ".alchemy", "local", "workflows"), {
        recursive: true,
      })
      .pipe(Effect.orDie);

    return Arr.map(
      Arr.filter(
        entries,
        (entry) =>
          entry.endsWith(".sqlite") &&
          path.basename(entry) !== "metadata.sqlite"
      ),
      (entry) => path.join(directory, ".alchemy", "local", "workflows", entry)
    );
  }
);

/** Every table of every engine database, as text. Read-only; the engine may be running. */
export const dumpEngine = Effect.fn("engineStorage.dump")(function* dumpEngine(
  directory: string
) {
  const files = yield* engineFiles(directory);

  return yield* Effect.forEach(files, (file) =>
    Effect.try({
      catch: (cause) =>
        new EngineStorageUnreadable({ file, reason: String(cause) }),
      try: () => dumpDatabase(file),
    })
  );
});

/** The rows of the table `name` across the engine's databases (one database per workflow instance). */
export const rowsOf = (
  dumps: readonly EngineDatabase[],
  name: string
): readonly EngineRow[] => {
  // A named intermediate: TypeScript cannot infer the callback of an outer flatMap over an inline flatMap.
  const tables = Arr.flatMap(dumps, (dump) => dump.tables);

  return Arr.flatMap(tables, (table) =>
    table.name === name ? table.rows : []
  );
};

/** The markers found in any cell of any table. */
export const markersInTables = (
  dumps: readonly EngineDatabase[],
  markers: readonly string[]
): readonly string[] =>
  Arr.filter(markers, (marker) =>
    Arr.some(dumps, (dump) =>
      Arr.some(dump.tables, (table) =>
        Arr.some(table.renderings, (text) => text.includes(marker))
      )
    )
  );

/**
 * The markers found in the raw bytes of the engine's files and their WAL and shared-memory files. A file that the
 * engine removed between the listing and the read is gone, and holds nothing; any other failure is loud.
 */
export const markersInFiles = Effect.fn("engineStorage.markersInFiles")(
  function* markersInFiles(directory: string, markers: readonly string[]) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(directory, ".alchemy", "local", "workflows");

    const entries = yield* fs
      .readDirectory(root, { recursive: true })
      .pipe(Effect.orDie);

    // `readDirectory` lists the directories too; only a regular file has bytes to search.
    const texts = yield* Effect.forEach(entries, (entry) => {
      const file = path.join(root, entry);

      return fs.stat(file).pipe(
        Effect.flatMap((info) =>
          info.type === "File"
            ? Effect.map(fs.readFile(file), renderingsOfBytes)
            : Effect.succeed<readonly string[]>([])
        ),
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed<readonly string[]>([])
        ),
        Effect.orDie
      );
    });

    return Arr.filter(markers, (marker) =>
      Arr.some(Arr.flatten(texts), (text) => text.includes(marker))
    );
  }
);
