import { createClient } from "@supabase/supabase-js";
import {
  Array as Arr,
  Config,
  Effect,
  FileSystem,
  Option,
  Redacted,
  Schema,
} from "effect";
import { SecureRandom } from "effect/crypto";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { PreviewError, readIdentity } from "./config.ts";
import type { PreviewIdentity } from "./config.ts";
import type { PreviewReceipt } from "./contracts.ts";

const BranchSchema = Schema.Struct({
  is_default: Schema.Boolean,
  name: Schema.String,
  parent_project_ref: Schema.String,
  project_ref: Schema.String,
  status: Schema.String,
  with_data: Schema.Boolean,
});

export type Branch = typeof BranchSchema.Type;

const token = (name: string) =>
  Config.Redacted(name).pipe(
    Effect.flatMap((value) =>
      Redacted.value(value)
        ? Effect.succeed(Redacted.value(value))
        : Effect.fail(new PreviewError({ message: `Missing ${name}` }))
    ),
    Effect.mapError(() => new PreviewError({ message: `Missing ${name}` }))
  );

const send = <A>(
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Codec<A>
) =>
  Effect.gen(function* sendRequest() {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request);

    if (response.status < 200 || response.status >= 300) {
      return yield* new PreviewError({
        message: `Provider request refused (HTTP ${response.status})`,
      });
    }

    return yield* HttpClientResponse.schemaBodyJson(schema)(response);
  }).pipe(
    Effect.mapError(
      () => new PreviewError({ message: "Provider request or response failed" })
    )
  );

const request = Effect.fnUntraced(function* request(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: Schema.Json
) {
  const access = yield* token("SUPABASE_ACCESS_TOKEN");
  const headers = { authorization: `Bearer ${access}` };

  let result = HttpClientRequest.make(method)(url, { headers });

  if (body !== undefined) {
    result = yield* HttpClientRequest.bodyJson(result, body);
  }

  return result;
});

const base = "https://api.supabase.com/v1";

const branches = Effect.fnUntraced(function* branches(parent: string) {
  return yield* send(
    yield* request("GET", `${base}/projects/${parent}/branches`),
    Schema.Array(BranchSchema)
  );
});

const ownedBranch = Effect.fnUntraced(function* ownedBranch(
  branchRef?: string
) {
  const identity = yield* readIdentity();
  const all = yield* branches(identity.parentProjectRef);

  const named = Arr.filter(
    all,
    (branch) => branch.name === identity.branchName
  );

  if (named.length > 1) {
    return yield* new PreviewError({
      message: "Duplicate preview branch name",
    });
  }

  const [branch] = named;

  if (
    branch &&
    (branch.parent_project_ref !== identity.parentProjectRef ||
      branch.is_default ||
      branch.with_data ||
      !/^[a-z0-9]{20}$/u.test(branch.project_ref) ||
      branch.project_ref === identity.parentProjectRef ||
      (branchRef !== undefined && branch.project_ref !== branchRef))
  ) {
    return yield* new PreviewError({
      message: "Preview branch ownership could not be established",
    });
  }

  return branch;
});

export const createOrReuseBranch = Effect.fnUntraced(
  function* createOrReuseBranch() {
    const identity = yield* readIdentity();
    const existing = yield* ownedBranch();

    if (existing) {
      return existing;
    }

    yield* send(
      yield* request(
        "POST",
        `${base}/projects/${identity.parentProjectRef}/branches`,
        {
          branch_name: identity.branchName,
          is_default: false,
          persistent: false,
          with_data: false,
        }
      ),
      BranchSchema
    );
    const created = yield* ownedBranch();

    if (!created) {
      return yield* new PreviewError({
        message: "Created branch is not visible in its designated parent",
      });
    }

    return created;
  }
);

export const deleteBranch = Effect.fnUntraced(
  function* deleteBranch(identity: PreviewIdentity) {
    const current = yield* readIdentity();

    if (
      identity.repository !== current.repository ||
      identity.pullRequest !== current.pullRequest ||
      identity.parentProjectRef !== current.parentProjectRef ||
      identity.branchName !== current.branchName ||
      identity.workerName !== current.workerName ||
      identity.headSha !== current.headSha ||
      identity.siteUrl !== current.siteUrl
    ) {
      return yield* new PreviewError({
        message: "Preview deletion identity does not match the current run",
      });
    }

    const branch = yield* ownedBranch();

    if (!branch) {
      return yield* Effect.void;
    }

    const client = yield* HttpClient.HttpClient;

    const response = yield* client.execute(
      yield* request("DELETE", `${base}/branches/${branch.project_ref}`)
    );

    if (
      response.status !== 404 &&
      (response.status < 200 || response.status >= 300)
    ) {
      return yield* new PreviewError({
        message: "Could not delete the owned preview branch",
      });
    }

    return yield* Effect.void;
  },
  Effect.mapError(
    () =>
      new PreviewError({
        message: "Could not verify or delete the owned preview branch",
      })
  )
);

const Inbox = Schema.Struct({
  id: Schema.Int,
  password: Schema.String,
  username: Schema.String,
});

const AuthConfig = Schema.Struct({
  disable_signup: Schema.Boolean,
  external_email_enabled: Schema.Boolean,
  hook_send_email_enabled: Schema.Boolean,
  mailer_autoconfirm: Schema.Boolean,
  mailer_subjects_invite: Schema.String,
  mailer_subjects_recovery: Schema.String,
  mailer_templates_invite_content: Schema.String,
  mailer_templates_recovery_content: Schema.String,
  site_url: Schema.String,
  smtp_host: Schema.String,
  smtp_port: Schema.String,
  smtp_user: Schema.String,
  uri_allow_list: Schema.String,
});

const RestConfig = Schema.Struct({ db_schema: Schema.String });

const Message = Schema.Struct({
  id: Schema.Int,
  subject: Schema.String,
  to_email: Schema.String,
});

const Messages = Schema.Array(Message);

export const captureSubjects = {
  invite: "Vektor preview account invitation",
  recovery: "Vektor preview password recovery",
} as const;

export const matchesCapturedMessage = (
  message: typeof Message.Type,
  recipient: string,
  kind: keyof typeof captureSubjects,
  excludedIds: readonly number[]
): boolean =>
  message.to_email === recipient &&
  message.subject === captureSubjects[kind] &&
  !excludedIds.includes(message.id);

const templates = Effect.fnUntraced(
  function* templates() {
    const fs = yield* FileSystem.FileSystem;

    const invite = yield* fs.readFileString(
      new URL("../../supabase/templates/invite.html", import.meta.url).pathname
    );

    const recovery = yield* fs.readFileString(
      new URL("../../supabase/templates/recovery.html", import.meta.url)
        .pathname
    );

    return { invite, recovery };
  },
  Effect.mapError(
    () => new PreviewError({ message: "Cannot read Auth templates" })
  )
);

export const mailbox = Effect.fnUntraced(function* mailbox() {
  const account = yield* token("MAILTRAP_ACCOUNT_ID");
  const inbox = yield* token("MAILTRAP_INBOX_ID");
  const apiToken = yield* token("MAILTRAP_API_TOKEN");
  const noForwarding = yield* Config.String("MAILTRAP_NO_FORWARDING_CONFIRMED");

  if (
    !/^[1-9][0-9]*$/u.test(account) ||
    !/^[1-9][0-9]*$/u.test(inbox) ||
    noForwarding !== "1"
  ) {
    return yield* new PreviewError({
      message: "Mailtrap sandbox designation is missing or invalid",
    });
  }

  const headers = { "Api-Token": apiToken };

  const info = yield* send(
    HttpClientRequest.get(
      `https://mailtrap.io/api/accounts/${account}/inboxes/${inbox}`,
      { headers }
    ),
    Inbox
  );

  if (String(info.id) !== inbox || !info.username || !info.password) {
    return yield* new PreviewError({
      message: "Mailtrap sandbox credentials are unavailable",
    });
  }

  return {
    account,
    headers,
    inbox,
    password: info.password,
    username: info.username,
  };
});

export const waitForCapturedMessage = Effect.fnUntraced(
  function* waitForCapturedMessage(
    box: Effect.Success<ReturnType<typeof mailbox>>,
    recipient: string,
    kind: keyof typeof captureSubjects,
    excludedIds: readonly number[]
  ) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const url = new URL(
        `https://mailtrap.io/api/accounts/${box.account}/inboxes/${box.inbox}/messages`
      );

      url.searchParams.set("search", recipient);

      const messages = yield* send(
        HttpClientRequest.get(url, { headers: box.headers }),
        Messages
      );

      for (const message of messages) {
        if (matchesCapturedMessage(message, recipient, kind, excludedIds)) {
          return message.id;
        }
      }

      yield* Effect.sleep("5 seconds");
    }

    return yield* new PreviewError({
      message: "Auth capture did not arrive in the designated sandbox",
    });
  }
);

export const configureServices = Effect.fnUntraced(function* configureServices(
  branch: Branch,
  siteUrl: string
) {
  const owned = yield* ownedBranch(branch.project_ref);

  if (!owned) {
    return yield* new PreviewError({
      message: "Preview branch no longer exists",
    });
  }

  const box = yield* mailbox();
  const emailTemplates = yield* templates();
  yield* send(
    yield* request(
      "PATCH",
      `${base}/projects/${branch.project_ref}/config/auth`,
      {
        disable_signup: true,
        external_email_enabled: true,
        hook_send_email_enabled: false,
        mailer_autoconfirm: false,
        mailer_subjects_invite: captureSubjects.invite,
        mailer_subjects_recovery: captureSubjects.recovery,
        mailer_templates_invite_content: emailTemplates.invite,
        mailer_templates_recovery_content: emailTemplates.recovery,
        site_url: siteUrl,
        smtp_admin_email: "preview@example.com",
        smtp_host: "sandbox.smtp.mailtrap.io",
        smtp_pass: box.password,
        smtp_port: "2525",
        smtp_sender_name: "Vektor preview",
        smtp_user: box.username,
        uri_allow_list: `${siteUrl}/**`,
      }
    ),
    Schema.Unknown
  );
  yield* send(
    yield* request(
      "PATCH",
      `${base}/projects/${branch.project_ref}/postgrest`,
      { db_schema: "graphql_public" }
    ),
    Schema.Unknown
  );

  return yield* Effect.void;
});

const Poolers = Schema.Array(
  Schema.Struct({
    connection_string: Schema.String,
    database_type: Schema.String,
    pool_mode: Schema.String,
  })
);

const sessionPooler = Effect.fnUntraced(function* sessionPooler(ref: string) {
  const poolers = yield* send(
    yield* request("GET", `${base}/projects/${ref}/config/database/pooler`),
    Poolers
  );

  const matches = Arr.filter(
    poolers,
    (pooler) => pooler.database_type === "PRIMARY"
  );

  const [match] = matches;

  if (!match || !URL.canParse(match.connection_string)) {
    return yield* new PreviewError({
      message: "Primary session pooler metadata is unavailable",
    });
  }

  const url = new URL(match.connection_string);

  for (const candidate of matches) {
    if (!URL.canParse(candidate.connection_string)) {
      return yield* new PreviewError({
        message: "Primary session pooler metadata is invalid",
      });
    }

    const parsed = new URL(candidate.connection_string);

    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname.endsWith(".pooler.supabase.com") ||
      parsed.hostname !== url.hostname ||
      !["5432", "6543"].includes(parsed.port) ||
      parsed.username !== `postgres.${ref}` ||
      parsed.pathname !== "/postgres"
    ) {
      return yield* new PreviewError({
        message: "Primary session pooler metadata is invalid",
      });
    }
  }

  // Supabase documents session mode on port 5432 for the same shared pooler host.
  url.protocol = "postgresql:";
  url.port = "5432";
  url.search = "";
  url.hash = "";

  return url;
});

const authMatchesSandbox = (
  auth: typeof AuthConfig.Type,
  siteUrl: string,
  username: string,
  emailTemplates: { readonly invite: string; readonly recovery: string }
): boolean =>
  auth.site_url === siteUrl &&
  auth.uri_allow_list === `${siteUrl}/**` &&
  auth.smtp_host === "sandbox.smtp.mailtrap.io" &&
  auth.smtp_port === "2525" &&
  auth.smtp_user === username &&
  auth.disable_signup &&
  auth.external_email_enabled &&
  !auth.mailer_autoconfirm &&
  auth.mailer_subjects_invite === captureSubjects.invite &&
  auth.mailer_subjects_recovery === captureSubjects.recovery &&
  !auth.hook_send_email_enabled &&
  auth.mailer_templates_invite_content === emailTemplates.invite &&
  auth.mailer_templates_recovery_content === emailTemplates.recovery;

export const preflight = Effect.fnUntraced(function* preflight(
  receipt: PreviewReceipt
) {
  const branch = yield* ownedBranch(receipt.branchRef);

  if (!branch) {
    return yield* new PreviewError({
      message: "Preview branch no longer exists",
    });
  }

  const box = yield* mailbox();
  const emailTemplates = yield* templates();

  const auth = yield* send(
    yield* request("GET", `${base}/projects/${receipt.branchRef}/config/auth`),
    AuthConfig
  );

  const rest = yield* send(
    yield* request("GET", `${base}/projects/${receipt.branchRef}/postgrest`),
    RestConfig
  );

  const pooler = yield* sessionPooler(receipt.branchRef);
  const admin = new URL(Redacted.value(receipt.migrationDatabaseUrl));
  const runtime = new URL(Redacted.value(receipt.runtimeDatabaseUrl));

  if (
    admin.hostname !== pooler.hostname ||
    admin.port !== pooler.port ||
    runtime.hostname !== pooler.hostname ||
    runtime.port !== pooler.port ||
    admin.username !== `postgres.${receipt.branchRef}` ||
    runtime.username !== `vektor_runtime.${receipt.branchRef}`
  ) {
    return yield* new PreviewError({
      message: "Preview receipt does not match live session pooler metadata",
    });
  }

  if (
    !authMatchesSandbox(auth, receipt.siteUrl, box.username, emailTemplates) ||
    rest.db_schema !== "graphql_public"
  ) {
    return yield* new PreviewError({
      message:
        "Preview Auth or Data API readback did not match the sandbox configuration",
    });
  }

  return yield* Effect.void;
});

export const probeCapture = Effect.fnUntraced(function* probeCapture(
  receipt: PreviewReceipt
) {
  yield* preflight(receipt);
  const box = yield* mailbox();
  const random = yield* SecureRandom.SecureRandom;
  const email = `preview-probe-${yield* random.uuidV4()}@example.com`;

  const supabase = createClient(
    receipt.supabaseUrl,
    Redacted.value(receipt.secretKey),
    {
      auth: { autoRefreshToken: false, persistSession: false },
    }
  );

  yield* Effect.acquireUseRelease(
    Effect.gen(function* acquireCaptureProbe() {
      const invited = yield* Effect.tryPromise({
        catch: () => new PreviewError({ message: "Auth capture probe failed" }),
        try: () => supabase.auth.admin.inviteUserByEmail(email),
      });

      if (invited.error) {
        return yield* new PreviewError({
          message: "Auth capture probe was refused",
        });
      }

      return invited.data.user.id;
    }),
    () => waitForCapturedMessage(box, email, "invite", []).pipe(Effect.asVoid),
    (userId) =>
      Effect.gen(function* releaseCaptureProbe() {
        const result = yield* Effect.tryPromise({
          catch: () =>
            new PreviewError({
              message: "Could not remove Auth capture probe user",
            }),
          try: () => supabase.auth.admin.deleteUser(userId),
        });

        if (result.error) {
          return yield* new PreviewError({
            message: "Could not remove Auth capture probe user",
          });
        }

        return yield* Effect.void;
      })
  );
});

const BranchConfig = Schema.Struct({
  db_host: Schema.String,
  db_pass: Schema.String,
  db_port: Schema.Union([Schema.String, Schema.Int]),
  db_user: Schema.String,
  ref: Schema.String,
});

const ApiKey = Schema.Struct({
  api_key: Schema.optionalKey(Schema.NullOr(Schema.String)),
  type: Schema.String,
});

const ApiKeys = Schema.Array(ApiKey);

const revealKey = (key: typeof ApiKey.Type, type: "publishable" | "secret") =>
  Effect.fromOption(
    Option.filter(
      Option.fromNullishOr(key.api_key),
      (value) => key.type === type && value !== ""
    ),
    () => new PreviewError({ message: "API key could not be revealed" })
  );

export const waitForBranch = Effect.fnUntraced(function* waitForBranch(
  ref: string
) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const branch = yield* ownedBranch(ref);

    if (!branch) {
      return yield* new PreviewError({
        message: "Preview branch disappeared during creation",
      });
    }

    if (
      branch.status === "MIGRATIONS_PASSED" ||
      branch.status === "FUNCTIONS_DEPLOYED"
    ) {
      return branch;
    }

    if (
      branch.status === "MIGRATIONS_FAILED" ||
      branch.status === "FUNCTIONS_FAILED"
    ) {
      return yield* new PreviewError({
        message: "Preview branch provisioning failed",
      });
    }

    yield* Effect.sleep("5 seconds");
  }

  return yield* new PreviewError({
    message: "Preview branch readiness timed out",
  });
});

export const branchCredentials = Effect.fnUntraced(function* branchCredentials(
  branch: Branch
) {
  const owned = yield* ownedBranch(branch.project_ref);

  if (!owned) {
    return yield* new PreviewError({
      message: "Preview branch no longer exists",
    });
  }

  const config = yield* send(
    yield* request("GET", `${base}/branches/${branch.project_ref}`),
    BranchConfig
  );

  if (
    config.ref !== branch.project_ref ||
    config.db_host !== `db.${branch.project_ref}.supabase.co` ||
    config.db_user !== "postgres" ||
    !config.db_pass
  ) {
    return yield* new PreviewError({
      message: "Branch database configuration is invalid",
    });
  }

  const keys = yield* send(
    yield* request(
      "GET",
      `${base}/projects/${branch.project_ref}/api-keys?reveal=true`
    ),
    ApiKeys
  );

  const getKey = Effect.fnUntraced(function* getKey(
    type: "publishable" | "secret"
  ) {
    const existing = Arr.findFirst(keys, (key) => key.type === type);

    if (Option.isSome(existing)) {
      return yield* revealKey(existing.value, type);
    }

    const body =
      type === "secret"
        ? {
            name: "vektor-preview",
            secret_jwt_template: { role: "service_role" },
            type,
          }
        : { name: "vektor-preview", type };

    const created = yield* send(
      yield* request(
        "POST",
        `${base}/projects/${branch.project_ref}/api-keys?reveal=true`,
        body
      ),
      ApiKey
    );

    return yield* revealKey(created, type);
  });

  const publishable = yield* getKey("publishable");
  const secret = yield* getKey("secret");

  const database = yield* sessionPooler(branch.project_ref);
  database.password = config.db_pass;
  database.searchParams.set("sslmode", "require");

  return {
    database: Redacted.make(database.toString()),
    publishable: Redacted.make(publishable),
    secret: Redacted.make(secret),
  };
});
