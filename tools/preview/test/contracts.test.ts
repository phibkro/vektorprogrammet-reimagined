import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Path,
  Redacted,
  Schema,
} from "effect";

import { readIdentity } from "../config.ts";
import { readReceipt, writeReceipt } from "../contracts.ts";
import type { PreviewReceipt } from "../contracts.ts";

const parent = "a".repeat(20);
const branch = "b".repeat(20);
const sha = "c".repeat(40);

const environment = {
  CLOUDFLARE_WORKERS_SUBDOMAIN: "synthetic",
  GITHUB_REPOSITORY: "phibkro/vektorprogrammet-reimagined",
  PREVIEW_HEAD_SHA: sha,
  PREVIEW_PR_NUMBER: "42",
  SUPABASE_PREVIEW_PROJECT_REF: parent,
};

const provider = (extra: Record<string, string> = {}) =>
  ConfigProvider.fromUnknown({ ...environment, ...extra });

const receiptFile = Effect.fnUntraced(function* receiptFile() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "preview-receipt-",
  });

  const file = path.join(directory, "state.json");

  return { config: provider({ PREVIEW_STATE_FILE: file }), file, fs };
});

const receipt: PreviewReceipt = {
  branchName: "vektorprogrammet-pr-42",
  branchRef: branch,
  headSha: sha,
  migrationDatabaseUrl: Redacted.make(
    `postgresql://postgres.${branch}:private@region.pooler.supabase.com:5432/postgres?sslmode=require`
  ),
  parentProjectRef: parent,
  publishableKey: Redacted.make("sb_publishable_fake_public"),
  pullRequest: 42,
  repository: environment.GITHUB_REPOSITORY,
  runtimeDatabaseUrl: Redacted.make(
    `postgresql://vektor_runtime.${branch}:private@region.pooler.supabase.com:5432/postgres?sslmode=require`
  ),
  secretKey: Redacted.make("sb_secret_fake_private"),
  siteUrl: "https://vektorprogrammet-pr-42.synthetic.workers.dev",
  supabaseUrl: `https://${branch}.supabase.co`,
  workerName: "vektorprogrammet-pr-42",
};

describe("preview identity", () => {
  it.effect(
    "refuses non-PR targets and identities from another repository",
    () =>
      Effect.gen(function* testCase() {
        const valid = yield* readIdentity().pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, provider())
        );

        assert.strictEqual(valid.workerName, "vektorprogrammet-pr-42");

        for (const pr of ["0", "-1", "main", "42x", "01"]) {
          yield* Effect.flip(
            readIdentity().pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                provider({ PREVIEW_PR_NUMBER: pr })
              )
            )
          );
        }

        yield* Effect.flip(
          readIdentity().pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              provider({ GITHUB_REPOSITORY: "other/repository" })
            )
          )
        );
      })
  );

  it.effect(
    "writes a private receipt, redacts secrets, and rejects changed identity",
    () =>
      Effect.gen(function* testCase() {
        const { file, fs, config: configuration } = yield* receiptFile();
        yield* writeReceipt(receipt).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configuration)
        );
        const info = yield* fs.lstat(file);
        assert.strictEqual(info.mode % 0o1000, 0o600);

        const restored = yield* readReceipt().pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configuration)
        );

        assert.strictEqual(
          Redacted.value(restored.secretKey),
          "sb_secret_fake_private"
        );

        const rendered = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown)
        )(restored);

        assert.notInclude(rendered, "sb_secret_fake_private");

        const refused = yield* Effect.flip(
          readReceipt().pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              provider({
                PREVIEW_HEAD_SHA: "d".repeat(40),
                PREVIEW_STATE_FILE: file,
              })
            )
          )
        );

        assert.strictEqual(refused._tag, "PreviewError");
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("rejects foreign host, branch username and transaction port", () =>
    Effect.gen(function* testCase() {
      const { config } = yield* receiptFile();

      for (const url of [
        `postgresql://vektor_runtime.${branch}:private@foreign.example:5432/postgres?sslmode=require`,
        `postgresql://vektor_runtime.${parent}:private@region.pooler.supabase.com:5432/postgres?sslmode=require`,
        `postgresql://vektor_runtime.${branch}:private@region.pooler.supabase.com:6543/postgres?sslmode=require`,
      ]) {
        yield* Effect.flip(
          writeReceipt({
            ...receipt,
            runtimeDatabaseUrl: Redacted.make(url),
          }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, config))
        );
      }
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "rejects swapped API keys and database option overrides on write and read",
    () =>
      Effect.gen(function* rejectUnsafeCredentials() {
        const { file, fs, config } = yield* receiptFile();
        const admin = Redacted.value(receipt.migrationDatabaseUrl);
        const runtime = Redacted.value(receipt.runtimeDatabaseUrl);

        const cases: PreviewReceipt[] = [
          {
            ...receipt,
            publishableKey: receipt.secretKey,
            secretKey: receipt.publishableKey,
          },
          {
            ...receipt,
            migrationDatabaseUrl: Redacted.make(`${admin}&host=other.example`),
          },
          {
            ...receipt,
            runtimeDatabaseUrl: Redacted.make(`${runtime}&host=other.example`),
          },
          {
            ...receipt,
            migrationDatabaseUrl: Redacted.make(`${admin}&host=other.example`),
            runtimeDatabaseUrl: Redacted.make(`${runtime}&host=other.example`),
          },
        ];

        for (const unsafe of cases) {
          const writeError = yield* Effect.flip(
            writeReceipt(unsafe).pipe(
              Effect.provideService(ConfigProvider.ConfigProvider, config)
            )
          );

          assert.strictEqual(writeError._tag, "PreviewError");
          assert.notInclude(writeError.message, "sb_secret_fake_private");
          assert.notInclude(writeError.message, admin);
          assert.notInclude(writeError.message, runtime);

          const encoded = {
            ...unsafe,
            migrationDatabaseUrl: Redacted.value(unsafe.migrationDatabaseUrl),
            publishableKey: Redacted.value(unsafe.publishableKey),
            runtimeDatabaseUrl: Redacted.value(unsafe.runtimeDatabaseUrl),
            secretKey: Redacted.value(unsafe.secretKey),
          };

          const json = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown)
          )(encoded);

          yield* fs.writeFileString(file, json, { mode: 0o600 });

          const readError = yield* Effect.flip(
            readReceipt().pipe(
              Effect.provideService(ConfigProvider.ConfigProvider, config)
            )
          );

          assert.strictEqual(readError._tag, "PreviewError");
          assert.notInclude(readError.message, "sb_secret_fake_private");
          assert.notInclude(readError.message, admin);
          assert.notInclude(readError.message, runtime);
        }
      }).pipe(Effect.provide(NodeServices.layer))
  );
});
