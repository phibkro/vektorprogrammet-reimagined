import { Config, Effect, FileSystem, Path, Redacted, Schema } from "effect";

import { PreviewError, readIdentity } from "./config.ts";

const ReceiptJson = Schema.Struct({
  branchName: Schema.String,
  branchRef: Schema.String,
  headSha: Schema.String,
  migrationDatabaseUrl: Schema.String,
  parentProjectRef: Schema.String,
  publishableKey: Schema.String.check(Schema.isPattern(/^sb_publishable_.+/u)),
  pullRequest: Schema.Int,
  repository: Schema.String,
  runtimeDatabaseUrl: Schema.String,
  secretKey: Schema.String.check(Schema.isPattern(/^sb_secret_.+/u)),
  siteUrl: Schema.String,
  supabaseUrl: Schema.String,
  workerName: Schema.String,
});

type EncodedReceipt = typeof ReceiptJson.Type;

export interface PreviewReceipt extends Omit<
  EncodedReceipt,
  "publishableKey" | "secretKey" | "migrationDatabaseUrl" | "runtimeDatabaseUrl"
> {
  readonly publishableKey: Redacted.Redacted;
  readonly secretKey: Redacted.Redacted;
  readonly migrationDatabaseUrl: Redacted.Redacted;
  readonly runtimeDatabaseUrl: Redacted.Redacted;
}

const privatePath = Effect.fnUntraced(function* privatePath() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* Config.String("PREVIEW_STATE_FILE");

  if (!file || !path.isAbsolute(file)) {
    return yield* new PreviewError({
      message: "PREVIEW_STATE_FILE must be an absolute private path",
    });
  }

  const parent = yield* fs.realPath(path.dirname(file));
  const location = path.join(parent, path.basename(file));
  let cursor = parent;

  for (;;) {
    if (yield* fs.exists(path.join(cursor, ".git"))) {
      return yield* new PreviewError({
        message: "Preview receipt must be outside Git",
      });
    }

    const next = path.dirname(cursor);

    if (next === cursor) {
      break;
    }

    cursor = next;
  }

  return location;
});

const databaseMatches = (receipt: EncodedReceipt): boolean => {
  const admin = new URL(receipt.migrationDatabaseUrl);
  const runtime = new URL(receipt.runtimeDatabaseUrl);

  return (
    admin.protocol === "postgresql:" &&
    admin.hostname.endsWith(".pooler.supabase.com") &&
    admin.port === "5432" &&
    admin.username === `postgres.${receipt.branchRef}` &&
    admin.password !== "" &&
    admin.pathname === "/postgres" &&
    runtime.protocol === admin.protocol &&
    runtime.hostname === admin.hostname &&
    runtime.port === admin.port &&
    runtime.pathname === admin.pathname &&
    runtime.username === `vektor_runtime.${receipt.branchRef}` &&
    runtime.password !== "" &&
    admin.search === "?sslmode=require" &&
    runtime.search === "?sslmode=require" &&
    runtime.hash === "" &&
    admin.hash === ""
  );
};

const validate = Effect.fnUntraced(function* validate(receipt: EncodedReceipt) {
  const identity = yield* readIdentity();

  if (
    receipt.repository !== identity.repository ||
    receipt.pullRequest !== identity.pullRequest ||
    receipt.headSha !== identity.headSha ||
    receipt.parentProjectRef !== identity.parentProjectRef ||
    receipt.branchName !== identity.branchName ||
    receipt.workerName !== identity.workerName ||
    receipt.siteUrl !== identity.siteUrl ||
    !/^[a-z0-9]{20}$/u.test(receipt.branchRef) ||
    receipt.branchRef === receipt.parentProjectRef ||
    receipt.supabaseUrl !== `https://${receipt.branchRef}.supabase.co` ||
    !receipt.publishableKey ||
    !receipt.secretKey ||
    !URL.canParse(receipt.migrationDatabaseUrl) ||
    !URL.canParse(receipt.runtimeDatabaseUrl)
  ) {
    return yield* new PreviewError({
      message: "Preview receipt identity does not match the current run",
    });
  }

  if (!databaseMatches(receipt)) {
    return yield* new PreviewError({
      message: "Preview database credentials do not match the branch",
    });
  }

  return receipt;
});

export const readReceipt = Effect.fnUntraced(
  function* readReceipt() {
    const fs = yield* FileSystem.FileSystem;
    const location = yield* privatePath();
    const info = yield* fs.lstat(location);

    if (info.type !== "File" || info.mode % 0o1000 !== 0o600) {
      return yield* new PreviewError({
        message: "Preview receipt must be a private regular file",
      });
    }

    const text = yield* fs.readFileString(location);

    const receipt = yield* Schema.decodeEffect(
      Schema.fromJsonString(ReceiptJson)
    )(text);

    const checked = yield* validate(receipt);

    return {
      ...checked,
      migrationDatabaseUrl: Redacted.make(checked.migrationDatabaseUrl),
      publishableKey: Redacted.make(checked.publishableKey),
      runtimeDatabaseUrl: Redacted.make(checked.runtimeDatabaseUrl),
      secretKey: Redacted.make(checked.secretKey),
    } satisfies PreviewReceipt;
  },
  Effect.mapError(
    () =>
      new PreviewError({
        message: "Cannot read or validate private preview receipt",
      })
  )
);

export const writeReceipt = Effect.fnUntraced(
  function* writeReceipt(receipt: PreviewReceipt) {
    const fs = yield* FileSystem.FileSystem;
    const location = yield* privatePath();

    const encoded: EncodedReceipt = {
      ...receipt,
      migrationDatabaseUrl: Redacted.value(receipt.migrationDatabaseUrl),
      publishableKey: Redacted.value(receipt.publishableKey),
      runtimeDatabaseUrl: Redacted.value(receipt.runtimeDatabaseUrl),
      secretKey: Redacted.value(receipt.secretKey),
    };

    const checked = yield* Schema.decodeEffect(ReceiptJson)(encoded);
    yield* validate(checked);

    if (yield* fs.exists(location)) {
      const info = yield* fs.lstat(location);

      if (info.type !== "File" || info.mode % 0o1000 !== 0o600) {
        return yield* new PreviewError({
          message: "Existing receipt is not private",
        });
      }
    }

    const temporary = `${location}.${process.pid}.tmp`;

    const json = yield* Schema.encodeEffect(Schema.fromJsonString(ReceiptJson))(
      encoded
    );

    yield* fs.writeFileString(temporary, json, {
      flag: "wx",
      mode: 0o600,
    });
    yield* fs
      .rename(temporary, location)
      .pipe(
        Effect.ensuring(
          fs.remove(temporary, { force: true }).pipe(Effect.ignore)
        )
      );

    return yield* Effect.void;
  },
  Effect.mapError(
    () => new PreviewError({ message: "Cannot write private preview receipt" })
  )
);
