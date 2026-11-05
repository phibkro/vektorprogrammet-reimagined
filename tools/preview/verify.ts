import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { chromium } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { Array as Arr, Config, Effect, Option, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";

import { openPage, signIn } from "../../apps/web/e2e/support/panel.ts";
import { Platform } from "../../apps/web/e2e/support/platformReport.ts";
import { requiredChecks } from "../../apps/web/src/core/store/platformRequirements.ts";
import { LOCAL_FAKE_PASSWORD } from "../../apps/web/test/fixtures/localPeople.ts";
import { PreviewError } from "./config.ts";
import { readReceipt } from "./contracts.ts";
import type { PreviewReceipt } from "./contracts.ts";
import { mailbox, preflight, waitForCapturedMessage } from "./supabase.ts";

const Isolation = Schema.Struct({
  probe: Schema.String,
  problems: Schema.Array(Schema.String),
  roleDefault: Schema.String,
  transactor: Schema.String,
});

export const Version = Schema.Struct({ headSha: Schema.String });

export const assertPlatform = (report: typeof Platform.Type): void => {
  if (
    report.deployment !== "preview" ||
    report.profile !== "supabase" ||
    report.problems.length !== 0 ||
    Arr.some(report.checks, (check) => !check.held) ||
    Arr.some(
      requiredChecks,
      ({ id }) =>
        Arr.filter(report.checks, (check) => check.id === id && check.held)
          .length !== 1
    )
  ) {
    throw new Error("Platform report did not hold every required check");
  }
};

export const assertIsolation = (report: typeof Isolation.Type): void => {
  if (
    report.transactor !== "read committed" ||
    report.probe !== "serializable" ||
    report.roleDefault !== "read committed" ||
    report.problems.length !== 0
  ) {
    throw new Error("Isolation report did not match the required levels");
  }
};

export const assertHead = (
  report: typeof Version.Type,
  headSha: string
): void => {
  if (report.headSha !== headSha) {
    throw new Error("Hosted Worker does not match the preview head");
  }
};

/** Playwright and Supabase own these Promise APIs; never expose their errors or payloads. */
const foreign = <A>(operation: () => PromiseLike<A>) =>
  Effect.tryPromise({
    catch: () =>
      new PreviewError({ message: "Hosted preview operation failed" }),
    try: () => Promise.resolve(operation()),
  }).pipe(Effect.uninterruptible);

const fail = () =>
  new PreviewError({ message: "Hosted preview assertion failed" });

const requireStatus = (actual: number | undefined, expected: number) =>
  actual === expected ? Effect.void : Effect.fail(fail());

const getJson = Effect.fnUntraced(function* getJson<A>(
  context: BrowserContext,
  url: string,
  schema: Schema.Codec<A>
) {
  const response = yield* foreign(() =>
    context.request.get(url, { maxRedirects: 0 })
  );

  yield* requireStatus(response.status(), 200);
  const body = yield* foreign(() => response.text());

  return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body);
});

const checkHead = Effect.fnUntraced(function* checkHead(
  context: BrowserContext,
  receipt: PreviewReceipt
) {
  const version = yield* getJson(
    context,
    `${receipt.siteUrl}/api/preview-version`,
    Version
  );

  yield* Effect.try(() => {
    assertHead(version, receipt.headSha);
  });
});

const diagnostics = Effect.fnUntraced(function* diagnostics(
  context: BrowserContext,
  receipt: PreviewReceipt
) {
  yield* checkHead(context, receipt);

  const platform = yield* getJson(
    context,
    `${receipt.siteUrl}/api/platform`,
    Platform
  );

  yield* Effect.try(() => {
    assertPlatform(platform);
  });

  const isolation = yield* getJson(
    context,
    `${receipt.siteUrl}/api/isolation`,
    Isolation
  );

  yield* Effect.try(() => {
    assertIsolation(isolation);
  });
});

const browserLogin = Effect.fnUntraced(function* browserLogin(
  context: BrowserContext,
  page: Page,
  receipt: PreviewReceipt
) {
  const home = yield* foreign(() =>
    context.request.get(`${receipt.siteUrl}/`, { maxRedirects: 0 })
  );

  yield* requireStatus(home.status(), 200);

  const anonymous = yield* foreign(() =>
    context.request.get(`${receipt.siteUrl}/kontrollpanel`, { maxRedirects: 0 })
  );

  yield* requireStatus(anonymous.status(), 403);
  yield* foreign(() =>
    signIn(page, receipt.siteUrl, "ada.admin@example.org", LOCAL_FAKE_PASSWORD)
  );

  const authenticated = yield* foreign(() =>
    context.request.get(`${receipt.siteUrl}/kontrollpanel`, { maxRedirects: 0 })
  );

  yield* requireStatus(authenticated.status(), 200);
});

const openNews = Effect.fnUntraced(function* openNews(
  page: Page,
  siteUrl: string
) {
  yield* foreign(() => openPage(page, `${siteUrl}/kontrollpanel/innhold`));
  yield* foreign(() => page.getByLabel("Samling").selectOption("news"));
});

const cmsJourney = Effect.fnUntraced(function* cmsJourney(
  browser: Browser,
  page: Page,
  receipt: PreviewReceipt,
  slug: string
) {
  yield* openNews(page, receipt.siteUrl);
  yield* foreign(() =>
    page.getByRole("button", { name: "Nytt innhold" }).click()
  );
  yield* foreign(() => page.getByLabel("Nøkkel").fill(slug));
  yield* foreign(() => page.getByLabel("Tittel").fill(slug));
  yield* foreign(() =>
    page.getByRole("button", { name: "Lagre utkast" }).click()
  );
  yield* foreign(() =>
    page.getByRole("status").filter({ hasText: "Utkastet er lagret" }).waitFor()
  );
  yield* openNews(page, receipt.siteUrl);
  yield* foreign(() =>
    page
      .getByRole("listitem")
      .filter({ hasText: slug })
      .getByRole("button", { name: "Rediger" })
      .click()
  );
  const title = yield* foreign(() => page.getByLabel("Tittel").inputValue());

  if (title !== slug) {
    return yield* fail();
  }

  const anonymous = yield* foreign(() => browser.newContext());
  const visitor = yield* foreign(() => anonymous.newPage());

  const draft = yield* foreign(() =>
    visitor.goto(`${receipt.siteUrl}/nyhet/${slug}`)
  );

  yield* requireStatus(draft?.status(), 404);
  yield* foreign(() =>
    page.getByRole("button", { name: "Publiser lagret utkast" }).click()
  );
  yield* foreign(() =>
    page
      .getByRole("status")
      .filter({ hasText: "Utkastet er publisert" })
      .waitFor()
  );

  const published = yield* foreign(() =>
    visitor.goto(`${receipt.siteUrl}/nyhet/${slug}`)
  );

  yield* requireStatus(published?.status(), 200);
  yield* foreign(() => visitor.getByRole("heading", { name: slug }).waitFor());

  return yield* Effect.void;
});

const cleanupContent = (receipt: PreviewReceipt, slug: string) =>
  Effect.gen(function* removeOwnedPreviewContent() {
    const sql = yield* SqlClient;
    yield* sql`delete from site_content where collection = 'news' and slug = ${slug} and draft->>'title' = ${slug}`;

    const remaining =
      yield* sql`select 1 from site_content where collection = 'news' and slug = ${slug}`;

    if (remaining.length !== 0) {
      return yield* Effect.die("Owned preview content remains");
    }

    return yield* Effect.void;
  }).pipe(
    Effect.provide(
      PgClient.layer({
        maxConnections: 1,
        prepare: false,
        url: receipt.migrationDatabaseUrl,
      })
    ),
    Effect.orDie
  );

const requireSupabaseSuccess = (result: { readonly error: unknown }) =>
  result.error === null ? Effect.void : Effect.fail(fail());

const storageJourney = Effect.fnUntraced(function* storageJourney(
  receipt: PreviewReceipt,
  context: BrowserContext,
  slug: string,
  client: Pick<ReturnType<typeof createClient>, "auth" | "storage">
) {
  const key = `${slug}.txt`;
  const bucket = client.storage.from("public-files");
  yield* Effect.acquireRelease(
    foreign(() =>
      bucket.upload(key, "preview smoke", {
        contentType: "text/plain",
        upsert: false,
      })
    ).pipe(Effect.flatMap(requireSupabaseSuccess)),
    () =>
      foreign(() => bucket.remove([key])).pipe(
        Effect.flatMap(requireSupabaseSuccess),
        Effect.orDie
      )
  );
  const downloaded = yield* foreign(() => bucket.download(key));

  if (downloaded.error !== null) {
    return yield* fail();
  }

  const text = yield* foreign(() => downloaded.data.text());

  if (text !== "preview smoke") {
    return yield* fail();
  }

  const response = yield* foreign(() =>
    context.request.get(
      `${receipt.supabaseUrl}/storage/v1/object/public/public-files/${key}`
    )
  );

  if (!Arr.contains([401, 403, 404], response.status())) {
    return yield* fail();
  }

  return yield* Effect.void;
});

const authMailJourney = Effect.fnUntraced(function* authMailJourney(
  receipt: PreviewReceipt,
  slug: string,
  client: Pick<ReturnType<typeof createClient>, "auth" | "storage">
) {
  const box = yield* mailbox();

  const recipient = `${slug}@example.com`;

  const user = yield* Effect.acquireRelease(
    foreign(() => client.auth.admin.inviteUserByEmail(recipient)).pipe(
      Effect.flatMap((result) =>
        result.error === null
          ? Effect.succeed(result.data.user)
          : Effect.fail(fail())
      )
    ),
    (owned) =>
      foreign(() => client.auth.admin.deleteUser(owned.id)).pipe(
        Effect.flatMap(requireSupabaseSuccess),
        Effect.orDie
      )
  );

  const invite = yield* waitForCapturedMessage(box, recipient, "invite", []);

  const confirmed = yield* foreign(() =>
    client.auth.admin.updateUserById(user.id, { email_confirm: true })
  );

  if (confirmed.error !== null) {
    return yield* fail();
  }

  const recovery = yield* foreign(() =>
    client.auth.resetPasswordForEmail(recipient, {
      redirectTo: `${receipt.siteUrl}/tilbakestill-passord`,
    })
  );

  if (recovery.error !== null) {
    return yield* fail();
  }

  yield* waitForCapturedMessage(box, recipient, "recovery", [invite]);

  return yield* Effect.void;
});

const runSmoke = Effect.fnUntraced(function* runSmoke(
  receipt: PreviewReceipt,
  slug: string
) {
  const executable = yield* Config.option(
    Config.String("E2E_BROWSER_EXECUTABLE_PATH")
  );

  const options = Option.isSome(executable)
    ? { executablePath: executable.value }
    : undefined;

  const browser = yield* Effect.acquireRelease(
    foreign(() => chromium.launch(options)),
    (owned) => foreign(() => owned.close()).pipe(Effect.orDie)
  );

  const context = yield* foreign(() => browser.newContext());
  const page = yield* foreign(() => context.newPage());
  yield* Effect.addFinalizer(() => cleanupContent(receipt, slug));
  yield* diagnostics(context, receipt);
  yield* browserLogin(context, page, receipt);
  yield* cmsJourney(browser, page, receipt, slug);

  const client = createClient(
    receipt.supabaseUrl,
    Redacted.value(receipt.secretKey),
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  yield* storageJourney(receipt, context, slug, client);
  yield* authMailJourney(receipt, slug, client);
  yield* checkHead(context, receipt);
});

const program = Effect.gen(function* program() {
  const receipt = yield* readReceipt();
  yield* preflight(receipt);
  const random = yield* SecureRandom.SecureRandom;
  const id = yield* random.uuidV4();
  yield* Effect.scoped(runSmoke(receipt, `preview-smoke-${id}`));
});

if (import.meta.main) {
  NodeRuntime.runMain(
    program.pipe(
      Effect.provide([
        NodeServices.layer,
        FetchHttpClient.layer,
        SecureRandom.layerWebCrypto,
      ]),
      Effect.catchCause(() =>
        Effect.die(
          "Hosted preview verification or fixture cleanup failed; owned fixtures may remain. Inspect private provider state without exposing credentials or links."
        )
      ),
      Effect.orDie
    )
  );
}
