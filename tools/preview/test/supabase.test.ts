import { assert, it } from "@effect/vitest";
import type { Schema } from "effect";
import {
  Array as Arr,
  ConfigProvider,
  Effect,
  FileSystem,
  Redacted,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { PreviewReceipt } from "../contracts.ts";
import {
  branchCredentials,
  captureSubjects,
  deleteBranch,
  matchesCapturedMessage,
  preflight,
} from "../supabase.ts";

const parent = "a".repeat(20);
const ref = "b".repeat(20);

const branch = {
  is_default: false,
  name: "vektorprogrammet-pr-42",
  parent_project_ref: parent,
  project_ref: ref,
  status: "MIGRATIONS_PASSED",
  with_data: false,
};

const receipt: PreviewReceipt = {
  branchName: branch.name,
  branchRef: ref,
  headSha: "c".repeat(40),
  migrationDatabaseUrl: Redacted.make(
    `postgresql://postgres.${ref}:private@region.pooler.supabase.com:5432/postgres?sslmode=require`
  ),
  parentProjectRef: parent,
  publishableKey: Redacted.make("key"),
  pullRequest: 42,
  repository: "phibkro/vektorprogrammet-reimagined",
  runtimeDatabaseUrl: Redacted.make(
    `postgresql://vektor_runtime.${ref}:private@region.pooler.supabase.com:5432/postgres?sslmode=require`
  ),
  secretKey: Redacted.make("secret"),
  siteUrl: "https://vektorprogrammet-pr-42.synthetic.workers.dev",
  supabaseUrl: `https://${ref}.supabase.co`,
  workerName: branch.name,
};

const provider = ConfigProvider.fromUnknown({
  CLOUDFLARE_WORKERS_SUBDOMAIN: "synthetic",
  GITHUB_REPOSITORY: receipt.repository,
  MAILTRAP_ACCOUNT_ID: "1",
  MAILTRAP_API_TOKEN: "private-mail-token",
  MAILTRAP_INBOX_ID: "2",
  MAILTRAP_NO_FORWARDING_CONFIRMED: "1",
  PREVIEW_HEAD_SHA: receipt.headSha,
  PREVIEW_PR_NUMBER: "42",
  SUPABASE_ACCESS_TOKEN: "private-test-token",
  SUPABASE_PREVIEW_PROJECT_REF: parent,
});

it("requires the requested capture subject and recipient, not just a new message ID", () => {
  const recipient = "probe@example.com";

  const invite = {
    id: 1,
    subject: captureSubjects.invite,
    to_email: recipient,
  };

  const duplicateInvite = { ...invite, id: 2 };
  const recovery = { ...invite, id: 3, subject: captureSubjects.recovery };

  assert.isTrue(matchesCapturedMessage(invite, recipient, "invite", []));
  assert.isFalse(matchesCapturedMessage(invite, recipient, "invite", [1]));
  assert.isFalse(
    matchesCapturedMessage(duplicateInvite, recipient, "recovery", [1])
  );
  assert.isFalse(
    matchesCapturedMessage(recovery, "other@example.com", "recovery", [1])
  );
  assert.isTrue(matchesCapturedMessage(recovery, recipient, "recovery", [1]));
});

const recordingResponse = (body: Schema.Json) => {
  const methods: string[] = [];

  const http = HttpClient.make((request) => {
    methods.push(request.method);

    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json(body))
    );
  });

  return { http, methods };
};

it.effect("never deletes a default, data-bearing or foreign branch", () =>
  Effect.gen(function* testCase() {
    for (const foreign of [
      { ...branch, is_default: true },
      { ...branch, with_data: true },
      { ...branch, parent_project_ref: ref },
      { ...branch, project_ref: parent },
    ]) {
      const { http, methods } = recordingResponse([foreign]);

      yield* Effect.flip(
        deleteBranch(receipt).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.provideService(ConfigProvider.ConfigProvider, provider)
        )
      );
      assert.isTrue(Arr.every(methods, (method) => method === "GET"));
    }
  })
);

it.effect("accepts an absent branch without issuing deletion", () =>
  Effect.gen(function* testCase() {
    const { http, methods } = recordingResponse([]);

    yield* deleteBranch(receipt).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(ConfigProvider.ConfigProvider, provider)
    );
    assert.isTrue(Arr.every(methods, (method) => method === "GET"));
  })
);

it.effect(
  "accepts sandbox preflight and refuses a delivery SMTP host without writes",
  () =>
    Effect.gen(function* testCase() {
      const methods: string[] = [];
      let smtpHost = "sandbox.smtp.mailtrap.io";
      let recoverySubject: string = captureSubjects.recovery;

      const http = HttpClient.make((request, url) => {
        methods.push(request.method);

        const response = (body: Schema.Json) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json(body))
          );

        if (url.hostname === "mailtrap.io") {
          return response({ id: 2, password: "private", username: "sandbox" });
        }

        if (url.pathname.endsWith("/branches")) {
          return response([branch]);
        }

        if (url.pathname.endsWith("/config/database/pooler")) {
          return response([
            {
              connection_string: `postgresql://postgres.${ref}:private@region.pooler.supabase.com:5432/postgres`,
              database_type: "PRIMARY",
              pool_mode: "session",
            },
          ]);
        }

        if (url.pathname.endsWith("/postgrest")) {
          return response({ db_schema: "graphql_public" });
        }

        return response({
          disable_signup: true,
          external_email_enabled: true,
          hook_send_email_enabled: false,
          mailer_autoconfirm: false,
          mailer_subjects_invite: captureSubjects.invite,
          mailer_subjects_recovery: recoverySubject,
          mailer_templates_invite_content: "template",
          mailer_templates_recovery_content: "template",
          site_url: receipt.siteUrl,
          smtp_host: smtpHost,
          smtp_port: "2525",
          smtp_user: "sandbox",
          uri_allow_list: `${receipt.siteUrl}/**`,
        });
      });

      const fs = FileSystem.makeNoop({
        readFileString: () => Effect.succeed("template"),
      });

      const check = preflight(receipt).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(ConfigProvider.ConfigProvider, provider)
      );

      yield* check;
      recoverySubject = captureSubjects.invite;
      yield* Effect.flip(check);
      recoverySubject = captureSubjects.recovery;
      smtpHost = "smtp.delivery.example";
      yield* Effect.flip(check);
      assert.isTrue(Arr.every(methods, (method) => method === "GET"));
    })
);

it.effect(
  "uses the documented IPv4 session endpoint, not the API transaction default",
  () =>
    Effect.gen(function* sessionEndpoint() {
      const bodies = new Map<string, Schema.Json>([
        [`/v1/projects/${parent}/branches`, [branch]],
        [
          `/v1/branches/${ref}`,
          {
            db_host: `db.${ref}.supabase.co`,
            db_pass: "private",
            db_port: 5432,
            db_user: "postgres",
            ref,
          },
        ],
        [
          `/v1/projects/${ref}/api-keys`,
          [
            { api_key: "sb_publishable_test", type: "publishable" },
            { api_key: "sb_secret_test", type: "secret" },
          ],
        ],
        [
          `/v1/projects/${ref}/config/database/pooler`,
          [
            {
              connection_string: `postgresql://postgres.${ref}:private@region.pooler.supabase.com:6543/postgres`,
              database_type: "PRIMARY",
              pool_mode: "transaction",
            },
          ],
        ],
      ]);

      const http = HttpClient.make((request, url) => {
        assert.strictEqual(request.method, "GET");
        const body = bodies.get(url.pathname);

        if (body === undefined) {
          return Effect.die("Unexpected provider endpoint");
        }

        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json(body))
        );
      });

      const credentials = yield* branchCredentials(branch).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(ConfigProvider.ConfigProvider, provider)
      );

      const url = new URL(Redacted.value(credentials.database));
      assert.strictEqual(url.hostname, "region.pooler.supabase.com");
      assert.strictEqual(url.username, `postgres.${ref}`);
      assert.strictEqual(url.port, "5432");
      assert.strictEqual(url.searchParams.get("sslmode"), "require");
    })
);
