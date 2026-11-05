import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Redacted,
  Schema,
} from "effect";
import { describe, expect } from "vite-plus/test";

import {
  GeneratedConfig,
  stageFor,
  validateStage,
  workerProperties,
} from "../cloudflare.ts";
import type { PreviewReceipt } from "../contracts.ts";
import { assertOwnedWorkerState, inspectWorkerRow } from "../runtime.ts";

const receipt: PreviewReceipt = {
  branchName: "vektorprogrammet-pr-42",
  branchRef: "branch",
  headSha: "a".repeat(40),
  migrationDatabaseUrl: Redacted.make("migration"),
  parentProjectRef: "synthetic",
  publishableKey: Redacted.make("publishable"),
  pullRequest: 42,
  repository: "phibkro/vektorprogrammet-reimagined",
  runtimeDatabaseUrl: Redacted.make("runtime"),
  secretKey: Redacted.make("secret"),
  siteUrl: "https://vektorprogrammet-pr-42.example.workers.dev",
  supabaseUrl: "https://branch.supabase.co",
  workerName: "vektorprogrammet-pr-42",
};

const accountId = "synthetic-account";

const owned = {
  attr: { accountId, workerName: receipt.workerName },
  logicalId: "Worker",
  props: { name: receipt.workerName },
  resourceType: "Cloudflare.Worker",
  status: "created" as const,
};

const checkWorker = (
  row: Parameters<typeof assertOwnedWorkerState>[0],
  recover = false
) => {
  assertOwnedWorkerState(row, receipt.workerName, accountId, recover);
};

describe("isolated preview Worker", () => {
  it("binds only the positive PR's exact stage and names", () => {
    expect(stageFor(receipt)).toBe("pr-42");
    expect(() => {
      validateStage(receipt, "pr-42");
    }).not.toThrow();

    for (const stage of ["main", "production", "default", "pr-43"]) {
      expect(() => {
        validateStage(receipt, stage);
      }).toThrow();
    }

    expect(() => {
      validateStage({ ...receipt, pullRequest: 0 }, "pr-0");
    }).toThrow();
    expect(() => {
      validateStage({ ...receipt, workerName: "production" }, "pr-42");
    }).toThrow();
    expect(() => {
      validateStage({ ...receipt, branchName: "other" }, "pr-42");
    }).toThrow();
  });

  it("admits only the owned Worker's persisted targets, including update snapshots", () => {
    expect(() => {
      checkWorker(owned);
    }).not.toThrow();

    const updating = {
      ...owned,
      old: { attr: owned.attr, props: owned.props },
      status: "updating" as const,
    };

    expect(() => {
      checkWorker(updating);
    }).not.toThrow();
    const creating = { ...owned, attr: undefined, status: "creating" as const };
    expect(() => {
      checkWorker(creating, true);
    }).not.toThrow();
    expect(() => {
      checkWorker(creating);
    }).toThrow();

    for (const row of [
      { ...owned, attr: { ...owned.attr, accountId: "other-account" } },
      { ...owned, attr: { ...owned.attr, workerName: "other-worker" } },
      { ...owned, attr: { ...owned.attr, namespace: "other-namespace" } },
      { ...owned, attr: { ...owned.attr, versionOf: "other-worker" } },
      { ...owned, attr: { ...owned.attr, previewOf: "other-worker" } },
      { ...owned, attr: { ...owned.attr, routes: [{ id: "other-route" }] } },
      { ...owned, attr: { ...owned.attr, affinityZoneIds: ["other-zone"] } },
      { ...owned, attr: { ...owned.attr, domain: { name: "other.example" } } },
      { ...owned, props: { ...owned.props, name: "other-worker" } },
      {
        ...owned,
        props: { ...owned.props, version: { parent: "other-worker" } },
      },
      { ...owned, removalPolicy: "retain" as const },
      { ...creating, propsIncomplete: true },
      { ...owned, resourceType: "Cloudflare.Other" },
      {
        ...updating,
        old: {
          ...updating.old,
          attr: { ...owned.attr, accountId: "other-account" },
        },
      },
      {
        ...updating,
        old: {
          ...updating.old,
          attr: { ...owned.attr, routes: [{ id: "other-route" }] },
        },
      },
      { ...owned, old: { attr: owned.attr, props: owned.props } },
    ]) {
      expect(() => {
        checkWorker(row);
      }).toThrow();
    }
  });
});

it.effect("decodes persisted state before authorizing provider targets", () =>
  Effect.gen(function* testStateBoundary() {
    const inspect = inspectWorkerRow(receipt.workerName);
    yield* inspect(owned);

    for (const row of [
      { ...owned, attr: { ...owned.attr, accountId: "another-account" } },
      { ...owned, attr: { ...owned.attr, routes: [{ id: "other-route" }] } },
      {
        ...owned,
        old: {
          attr: { ...owned.attr, versionOf: "other" },
          props: owned.props,
        },
        status: "updating",
      },
      { ...owned, attr: undefined },
    ]) {
      expect(Exit.isFailure(yield* Effect.exit(inspect(row)))).toBe(true);
    }
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ CLOUDFLARE_ACCOUNT_ID: accountId })
    )
  )
);

it.effect(
  "uploads generated configuration with redacted privileged bindings",
  () =>
    Effect.gen(function* generatedBindings() {
      const config = yield* Schema.encodeEffect(
        Schema.fromJsonString(GeneratedConfig)
      )({
        assets: { directory: "../client" },
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat", "enable_request_signal"],
        main: "index.js",
        ratelimits: [
          {
            name: "CONTACT_RATE_LIMIT",
            namespace_id: "1",
            simple: { limit: 5, period: 60 },
          },
        ],
        triggers: { crons: ["* * * * *"] },
      });

      const props = yield* workerProperties(receipt).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ readFileString: () => Effect.succeed(config) })
        ),
        Effect.provide(NodeServices.layer)
      );

      expect(props.bundle).toBe(false);
      expect(props.main.endsWith("/dist/server/index.js")).toBe(true);
      expect(props.assets.endsWith("/dist/client")).toBe(true);
      expect(props.crons).toEqual(["* * * * *"]);
      expect(props.env.DEPLOYMENT).toBe("preview");
      expect(props.env.PREVIEW_HEAD_SHA).toBe(receipt.headSha);
      expect(props.env.DATABASE_URL).toBe(receipt.runtimeDatabaseUrl);
      expect(props.env.SUPABASE_SECRET_KEY).toBe(receipt.secretKey);
      expect(props.tags).toContain(`commit:${receipt.headSha}`);
    })
);
