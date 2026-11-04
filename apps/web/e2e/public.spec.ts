/** Public pages, real private Storage, PostgreSQL content, and the in-app editor.
 * The content and organisation fixtures are synthetic; publication is exercised through the UI.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { LOCAL_FAKE_PASSWORD } from "@vektorprogrammet/domain";
import { Array as Arr, Config, Effect, Option, Record as Rec } from "effect";

import { openPage, screenshot, signIn } from "./support/panel.ts";
import {
  LEGACY_FILE_KEY,
  activeDepartments,
  auditEntryCount,
  capturedSlackFor,
  forgetLegacyFile,
  outboxRows,
  registerLegacyFile,
  runDatabase,
} from "./support/probes.ts";
import { PUBLIC_FILE_FIXTURE_TEXT } from "./support/publicFile.ts";

test.describe.configure({ mode: "serial" });

test("falsifier 5: a registered public file serves bytes and headers; an unknown key is 404", async ({
  request,
}) => {
  const key = Effect.runSync(Config.String("E2E_PUBLIC_FILE_KEY"));
  expect(key).toMatch(/^[0-9a-f]{64}\.bin$/u);
  const response = await request.get(`/filer/${key}`);
  expect(response.status()).toBe(200);
  expect(await response.text()).toBe(PUBLIC_FILE_FIXTURE_TEXT);

  const headers = response.headers();
  expect(headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(headers["content-disposition"]).toBe(
    "attachment; filename=\"vektorprogrammet-e2e-fixture.bin\"; filename*=UTF-8''vektorprogrammet-e2e-fixture.bin"
  );
  // workerd omits Content-Length from this streamed Worker response.
  expect(headers["content-security-policy"]).toBe(
    "sandbox; default-src 'none'"
  );
  expect(headers["content-type"]).toBe("application/octet-stream");
  expect(headers["x-content-type-options"]).toBe("nosniff");

  const unknown = await request.get("/filer/nope");
  expect(unknown.status()).toBe(404);
});

test("pre-hydration sign-in never sends credentials in the URL", async ({
  browser,
}) => {
  const { origin } = new URL(test.info().project.use.baseURL ?? "");
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  try {
    await page.goto(`${origin}/logg-inn`);
    await expect(
      page.getByRole("button", { exact: true, name: "Logg inn" })
    ).toBeDisabled();
    await page
      .getByLabel("E-post", { exact: true })
      .fill("pre-hydration@example.org");
    await page.getByLabel("Passord", { exact: true }).fill(LOCAL_FAKE_PASSWORD);

    // Even a forced native submit must use the body, never the address or its history.
    const [response] = await Promise.all([
      page.waitForResponse((incoming) =>
        incoming.request().isNavigationRequest()
      ),
      page.locator("form").evaluate((form: HTMLFormElement) => {
        form.submit();
      }),
    ]);

    expect(response.request().method()).toBe("POST");
    const destination = new URL(response.url());
    expect(destination.searchParams.has("email")).toBe(false);
    expect(destination.searchParams.has("password")).toBe(false);
  } finally {
    await context.close();
  }
});

/** The visible heading of a page: its one `h1`. */
const heading = (page: Page, name: string) =>
  page.getByRole("heading", { exact: true, level: 1, name });

/** A page of the site, its visible heading and the headings supplied by its content and layout. */
const PAGES = [
  {
    h1: "Om Vektorprogrammet",
    h2: ["Motivere elever", "Motivere studenter", "En forsmak til læreryrket!"],
    path: "/om-oss",
  },
  {
    h1: "Assistenter",
    h2: ["Hvorfor bli assistent?", "Hvordan blir jeg Vektorassistent?"],
    path: "/assistenter",
  },
  {
    h1: "Informasjon for foreldre",
    h2: ["Assistentene", "Foreldrekurs", "Hvorfor foreldrekurs?"],
    path: "/foreldre",
  },
  {
    h1: "Vektorassistenter i skolen",
    h2: ["Søk om å få assistenter til din skole"],
    path: "/skoler",
  },
] as const;

test("falsifier 1: home renders published content and the department admission state", async ({
  page,
}) => {
  await openPage(page, "/");

  await expect(heading(page, "Vektorprogrammet")).toBeVisible();
  // The tagline comes from the published content fixture.
  await expect(
    page.getByText("Vektorprogrammet arbeider for å øke interessen")
  ).toBeVisible();
  // The only admission period of the fixture ended long ago.
  await expect(
    page.getByRole("heading", { name: "Opptaket er stengt for øyeblikket." })
  ).toBeVisible();

  // The fixture contains one published article and two drafts: only the published one is news.
  const news = page.getByRole("region", { name: "Nyheter" });
  await expect(
    news.getByRole("link", { name: /Opptak åpner/u })
  ).toHaveAttribute("href", "/nyhet/opptak-apner");
  await expect(
    news.getByRole("link", { name: /Kladd|Uten status/u })
  ).toHaveCount(0);

  // One of the fixture's three sponsors was valid; it is in the footer of every page.
  const sponsors = page
    .getByRole("contentinfo")
    .getByRole("region", { name: "Sponsorer og samarbeidspartnere" });

  await expect(
    sponsors.getByRole("link", { name: "Sponsor En" })
  ).toHaveAttribute("href", "https://sponsor-en.example");
  await expect(sponsors.getByRole("link")).toHaveCount(1);
  await screenshot(page, "public-home");
});

for (const { h1, h2, path } of PAGES) {
  test(`falsifier 1: ${path} renders its published texts`, async ({ page }) => {
    await openPage(page, path);

    await expect(heading(page, h1)).toBeVisible();

    for (const name of h2) {
      await expect(
        page.getByRole("heading", { exact: true, level: 2, name })
      ).toBeVisible();
    }

    await screenshot(page, `public${path.replaceAll("/", "-")}`);
  });
}

test("falsifier 1: /assistenter and /team show their published FAQ entries", async ({
  page,
}) => {
  const questions = page.locator("[data-slot='accordion-trigger']");

  await openPage(page, "/assistenter");
  await expect(questions).toHaveCount(9);
  await expect(
    page.getByRole("button", { name: "Er verv i Vektorprogrammet betalt?" })
  ).toBeVisible();

  await openPage(page, "/team");
  await expect(questions).toHaveCount(4);

  // An answer opens and closes in the page.
  const question = page.getByRole("button", {
    name: "Hvordan søker jeg team?",
  });

  await question.click();
  await expect(question).toHaveAttribute("aria-expanded", "true");
});

test("falsifier 1: /team, /nyheter, /kontakt and /skoler list the departments of PostgreSQL", async ({
  page,
}) => {
  const departments = await runDatabase(activeDepartments);
  expect(departments.length).toBeGreaterThan(0);

  for (const path of ["/team", "/nyheter"]) {
    await openPage(page, path);

    for (const { shortName } of departments) {
      await expect(
        page.getByRole("link", { exact: true, name: shortName }).first()
      ).toBeVisible();
    }
  }

  await screenshot(page, "public-news");

  await openPage(page, "/kontakt");
  const tabs = page.getByRole("navigation", { name: "Velg avdeling" });
  await expect(tabs.getByRole("link")).toHaveText(
    Arr.map(departments, ({ shortName }) => shortName)
  );
  await screenshot(page, "public-contact");

  await openPage(page, "/skoler");

  for (const { city } of departments) {
    await expect(
      page.getByRole("link", { exact: true, name: city })
    ).toBeVisible();
  }
});

test("falsifier 1: published news is public and drafts are not (RULE-267)", async ({
  page,
}) => {
  await openPage(page, "/nyheter");
  await expect(heading(page, "Nyheter")).toBeVisible();
  await expect(page.getByRole("link", { name: /Opptak åpner/u })).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Kladd|Uten status/u })
  ).toHaveCount(0);

  await page.getByRole("link", { name: /Opptak åpner/u }).click();
  await expect(page).toHaveURL(/\/nyhet\/opptak-apner$/u);
  await expect(heading(page, "Opptak åpner")).toBeVisible();
  await expect(page.getByRole("main")).toContainText(
    "Opptaket er åpent for søknader."
  );
  // Published portable text must not produce executable script elements.
  await expect(page.getByRole("main")).not.toContainText("alert(1)");
  await expect(page.getByRole("main").locator("script")).toHaveCount(0);
  await screenshot(page, "public-article");

  for (const slug of ["kladd", "uten-status"]) {
    const response = await page.goto(`/nyhet/${slug}`);
    expect(response?.status()).toBe(404);
  }
});

const EDITED_TAGLINE = "Teksten ble endret av en redaktør.";

test("a saved draft is private until an editor publishes it", async ({
  page,
  browser,
}) => {
  const { origin } = new URL(test.info().project.use.baseURL ?? "");
  const context = await browser.newContext();
  const editor = await context.newPage();
  const pageErrors: string[] = [];
  editor.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  await signIn(editor, origin, "ada.admin@example.org", LOCAL_FAKE_PASSWORD);
  await openPage(editor, `${origin}/kontrollpanel/innhold`);
  await editor
    .getByRole("listitem")
    .filter({ hasText: "home-tagline" })
    .getByRole("button", { name: "Rediger" })
    .click();
  const content = editor.getByLabel("Innhold", { exact: true });
  const original = await content.textContent();

  if (original === null) {
    throw new Error("Editor content is missing");
  }

  await content.fill(EDITED_TAGLINE);
  await editor.getByRole("button", { name: "Lagre utkast" }).click();
  await expect(editor.getByRole("status")).toContainText("Utkastet er lagret");
  await openPage(page, "/");
  await expect(page.getByText(EDITED_TAGLINE)).toHaveCount(0);
  await editor.getByRole("button", { name: "Publiser lagret utkast" }).click();
  await expect(editor.getByRole("status")).toContainText(
    "Utkastet er publisert"
  );
  await openPage(page, "/");
  await expect(page.getByText(EDITED_TAGLINE)).toBeVisible();
  await content.fill(original);
  await editor.getByRole("button", { name: "Lagre utkast" }).click();
  await expect(editor.getByRole("status")).toContainText("Utkastet er lagret");
  await editor.getByRole("button", { name: "Publiser lagret utkast" }).click();
  await expect(editor.getByRole("status")).toContainText(
    "Utkastet er publisert"
  );
  await context.close();
  expect(pageErrors).toEqual([]);
});

/** What the form needs to be sent: three fields and a message (an ASCII address: the browser refuses `ø` before the `@`). */
const FORM = {
  "Din e-post": "besokende@example.org",
  "Ditt navn": "Test Besøkende",
  Emne: "Spørsmål om opptak",
  Melding: "Når åpner opptaket neste gang?",
} as const;

const fillForm = async (page: Page) => {
  for (const [label, value] of Rec.toEntries(FORM)) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
};

const CAPTCHA_MESSAGE = "Bekreft at du ikke er en robot, og prøv igjen.";

test("falsifier 3 (RULE-167): a post without a Turnstile answer is refused with 422 and queues nothing", async ({
  page,
}) => {
  // Without Cloudflare's widget script there is no answer to send, whatever the visitor does.
  await page.route("https://challenges.cloudflare.com/**", async (route) => {
    await route.abort();
  });
  const outboxBefore = await runDatabase(outboxRows);
  const auditBefore = await runDatabase(auditEntryCount);

  await openPage(page, "/kontakt");
  await fillForm(page);

  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.startsWith("/kontakt")
  );

  await page.getByRole("button", { name: "Send melding" }).click();

  const refusal = await answered;
  expect(refusal.status()).toBe(422);
  await expect(page.getByRole("alert")).toContainText(CAPTCHA_MESSAGE);
  // The visitor's text is still in the form.
  await expect(
    page.getByRole("textbox", { exact: true, name: "Melding" })
  ).toHaveValue(FORM.Melding);

  expect(await runDatabase(outboxRows)).toEqual(outboxBefore);
  expect(await runDatabase(auditEntryCount)).toBe(auditBefore);
});

test("falsifier 3 (RULE-156, RULE-249): a valid post queues the notifications of one transaction, and no ticket or audit entry", async ({
  page,
}) => {
  const departments = await runDatabase(activeDepartments);
  // The last department, not the first: `/kontakt` shows the first, so choosing another tab is a client-side move
  // to a new form, whose own heading says when it has replaced the old one.
  const department = Arr.last(departments).pipe(Option.getOrUndefined);
  expect(department).toBeDefined();
  const outboxBefore = await runDatabase(outboxRows);
  const auditBefore = await runDatabase(auditEntryCount);

  await openPage(page, "/kontakt");
  await page
    .getByRole("navigation", { name: "Velg avdeling" })
    .getByRole("link", { exact: true, name: department?.shortName ?? "" })
    .click();
  await expect(page).toHaveURL(/\/kontakt\/[^/?]+$/u);
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: `Kontakt ${department?.shortName ?? ""}`,
    })
  ).toBeVisible();
  await fillForm(page);

  // Turnstile's always-pass test key fills in an answer once its widget has run.
  await expect(page.locator("[name='cf-turnstile-response']")).not.toHaveValue(
    "",
    {
      timeout: 30_000,
    }
  );
  await page.getByRole("button", { name: "Send melding" }).click();

  // 303 to the receipt, which answers 301 to the department's own page, with the notice.
  await expect(page).toHaveURL(/\/kontakt\/[^/?]+\?sendt=1$/u);
  await expect(page.getByRole("status")).toContainText(
    `Kontaktforespørsel sendt til ${department?.email ?? ""}`
  );
  await screenshot(page, "public-contact-sent");

  // RULE-249: the department's e-mail, the receipt, the department's Slack channel when it has one, #notifications.
  const queued = Arr.drop(await runDatabase(outboxRows), outboxBefore.length);
  expect(Arr.map(queued, ({ kind }) => kind)).toEqual(
    department?.slackChannel === null
      ? ["Email", "Email", "SlackPost"]
      : ["Email", "Email", "SlackPost", "SlackPost"]
  );
  // One `enqueue` call, one INSERT, one instant for all of them: the command's rows are written together.
  expect(new Set(Arr.map(queued, ({ queuedAt }) => queuedAt)).size).toBe(1);

  // The non-production sender persists each Slack delivery under its outbox key.
  for (const row of Arr.filter(
    queued,
    (message) => message.kind === "SlackPost"
  )) {
    await expect
      .poll(async () => await runDatabase(capturedSlackFor(String(row.id))))
      .toBe(1);
  }

  // The legacy ticket was never stored, and an anonymous visitor's post is not an audited staff write.
  expect(await runDatabase(auditEntryCount)).toBe(auditBefore);
});

/** An alias, the page it moved to, and the status: the legacy URLs answer 301 (spec 0005, falsifier 5). */
const ALIASES = [
  ["/om", "/om-oss"],
  ["/om/", "/om-oss"],
  ["/bedrifter", "/om-oss"],
  ["/faq", "/om-oss"],
  ["/omvektor", "/om-oss"],
  ["/artikkel/opptak-apner", "/nyhet/opptak-apner"],
  ["/nyheter/alfaby", "/nyheter?avdeling=alfaby"],
  ["/nyheter/alfaby?side=2", "/nyheter?avdeling=alfaby&side=2"],
] as const;

for (const [from, to] of ALIASES) {
  test(`falsifier 5: ${from} answers 301 to ${to}`, async ({ request }) => {
    const response = await request.get(from, { maxRedirects: 0 });

    expect(response.status()).toBe(301);
    expect(response.headers().location).toBe(to);
  });
}

test("falsifier 5: a legacy file path answers 301 to the registered file, and an unregistered one is 404", async ({
  request,
  page,
}) => {
  const legacyPath = "images/Logo images/e2e-logo.png";
  const url = "/images/Logo%20images/e2e-logo.png";

  const unregistered = await request.get(url, { maxRedirects: 0 });
  expect(unregistered.status()).toBe(404);

  await runDatabase(registerLegacyFile(legacyPath));

  try {
    const response = await request.get(url, { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    expect(response.headers().location).toBe(`/filer/${LEGACY_FILE_KEY}`);

    const { origin } = new URL(test.info().project.use.baseURL ?? "");
    await signIn(page, origin, "ada.admin@example.org", LOCAL_FAKE_PASSWORD);
    const signedIn = await page.request.get(url, { maxRedirects: 0 });
    expect(signedIn.status()).toBe(301);
    expect(signedIn.headers().location).toBe(`/filer/${LEGACY_FILE_KEY}`);
  } finally {
    await runDatabase(forgetLegacyFile);
  }
});

test("falsifier 5: the receipt address of the contact form answers 301 to the department's page", async ({
  request,
}) => {
  const [department] = await runDatabase(activeDepartments);

  const response = await request.get(
    `/kontakt/avdeling/${department?.id ?? 0}?sendt=1`,
    {
      maxRedirects: 0,
    }
  );

  expect(response.status()).toBe(301);
  expect(response.headers().location).toMatch(/^\/kontakt\/[^/?]+\?sendt=1$/u);
});
