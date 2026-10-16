/**
 * Import configuration, read from the environment only (no URL or path is a
 * default, and none is ever logged):
 *
 * | Variable                     | Meaning                                                        |
 * | ---------------------------- | -------------------------------------------------------------- |
 * | `LEGACY_MYSQL_URL`           | the restored backup, read with the SELECT-only `legacy_reader` |
 * | `IMPORT_TARGET_DATABASE_URL` | the PostgreSQL target (a Neon branch), connected directly      |
 * | `DATABASE_URL`               | the development database; the import refuses to write to it    |
 * | `LEGACY_FILES_DIR`           | optional legacy web root; absent → every file is missing       |
 */
import {
  Array as Arr,
  Config,
  HashSet,
  Option,
  Redacted,
  Schema,
} from "effect";

export const ImportConfig = Config.all({
  developmentUrl: Config.option(Config.Redacted("DATABASE_URL")),
  legacyFilesDir: Config.option(Config.NonEmptyString("LEGACY_FILES_DIR")),
  legacyMysqlUrl: Config.Redacted("LEGACY_MYSQL_URL"),
  targetUrl: Config.Redacted("IMPORT_TARGET_DATABASE_URL"),
});

export type ImportConfig =
  typeof ImportConfig extends Config.Config<infer A> ? A : never;

export class RefusedTarget extends Schema.TaggedError<
  RefusedTarget,
  { readonly brand: unique symbol }
>()("RefusedTarget", {
  message: Schema.String,
}) {}

const LOOPBACK = HashSet.fromIterable(["127.0.0.1", "[::1]", "localhost"]);

const databaseIdentity = (url: URL): string => {
  const host = url.hostname.toLowerCase();

  return Arr.join(
    [
      HashSet.has(LOOPBACK, host) ? "loopback" : host,
      url.port === "" ? "5432" : url.port,
      url.pathname.replace(/^\//u, ""),
    ],
    "\u0000"
  );
};

/**
 * Whether two PostgreSQL URLs name the same database: same host (loopback
 * aliases are equal), port (default 5432) and database name. Unparsable URLs
 * compare as exact strings.
 */
export const sameDatabase = (a: string, b: string): boolean => {
  if (a === b) {
    return true;
  }

  if (!URL.canParse(a) || !URL.canParse(b)) {
    return false;
  }

  return databaseIdentity(new URL(a)) === databaseIdentity(new URL(b));
};

/**
 * The import truncates its target. It refuses the development database
 * (`DATABASE_URL`) unless the operator passed `--allow-dev-database`.
 */
export const checkTarget = (
  config: Pick<ImportConfig, "targetUrl" | "developmentUrl">,
  allowDevelopmentDatabase: boolean
): Option.Option<RefusedTarget> =>
  Option.isSome(config.developmentUrl) &&
  !allowDevelopmentDatabase &&
  sameDatabase(
    Redacted.value(config.targetUrl),
    Redacted.value(config.developmentUrl.value)
  )
    ? Option.some(
        new RefusedTarget({
          message:
            "IMPORT_TARGET_DATABASE_URL is the development database (DATABASE_URL). The import truncates its target; pass --allow-dev-database to import into it anyway.",
        })
      )
    : Option.none();
