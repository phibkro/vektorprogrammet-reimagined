/**
 * Spec 0005, the public site in a browser, against `vp dev` (the `local` deployment), a CMS that is EmDash itself
 * (`apps/cms` under `astro dev`, `e2e/support/cms.ts`) holding the default copy of `apps/cms/seed/seed.json` and
 * the importer's fake articles, texts and sponsors, and a PostgreSQL database that the importer filled from its
 * fake legacy fixture. The pages read the CMS over its REST API with a token and the departments from
 * PostgreSQL: these tests check what an anonymous visitor sees. `journey.spec.ts` runs first (Playwright takes
 * the files in name order) and leaves its own departments behind, so what the pages must list about departments
 * is read from the database, not written here.
 *
 * Falsifier 1: every page renders from the CMS and PostgreSQL. Falsifier 2: an edit published in the CMS shows
 * without a deploy. Falsifier 3: the contact form queues its notifications in one transaction. Falsifier 5: the
 * legacy URLs answer 301.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Array as Arr, Config, Effect, Option, Record as Rec } from "effect";

import {
  paragraph,
  publishText,
  readText,
  runCms,
  saveText,
} from "./support/editor.ts";
import { openPage, screenshot } from "./support/panel.ts";
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

/** The visible heading of a page: its one `h1`. */
const heading = (page: Page, name: string) =>
  page.getByRole("heading", { exact: true, level: 1, name });

/** A page of the site, the `h1` it shows and the `h2` headings that its CMS texts and layout give it. */
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

test("falsifier 1: the home page shows the CMS's tagline, its published news and its sponsors, and the admission state of PostgreSQL", async ({
  page,
}) => {
  await openPage(page, "/");

  await expect(heading(page, "Vektorprogrammet")).toBeVisible();
  // The tagline is the default copy of the CMS's `home-tagline` text.
  await expect(
    page.getByText("Vektorprogrammet arbeider for å øke interessen")
  ).toBeVisible();
  // The only admission period of the fixture ended long ago.
  await expect(
    page.getByRole("heading", { name: "Opptaket er stengt for øyeblikket." })
  ).toBeVisible();

  // The importer put one published article and two drafts in the CMS: only the published one is news.
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
  test(`falsifier 1: ${path} renders its texts from the CMS`, async ({
    page,
  }) => {
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

test("falsifier 1: the FAQ of /assistenter and /team are the CMS's `faq` entries", async ({
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

test("falsifier 1: the news list and an article come from the CMS; a draft is not public (RULE-267)", async ({
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
  // RULE-133: the legacy article had a <script>; the importer's sanitiser removed it, and the page never runs one.
  await expect(page.getByRole("main")).not.toContainText("alert(1)");
  await expect(page.getByRole("main").locator("script")).toHaveCount(0);
  await screenshot(page, "public-article");

  for (const slug of ["kladd", "uten-status"]) {
    const response = await page.goto(`/nyhet/${slug}`);
    expect(response?.status()).toBe(404);
  }
});

/** The text a published edit puts in the CMS, and the text the page starts with. */
const EDITED_TAGLINE = "Teksten ble endret av en redaktør i CMS-et.";

test("falsifier 2: a text saved in the CMS is not public until it is published, and then it shows without a deploy", async ({
  page,
}) => {
  const original = await runCms(readText("home-tagline"));

  await openPage(page, "/");
  await expect(page.getByText(EDITED_TAGLINE)).toHaveCount(0);

  // An editor's save of a published text is a draft: the visitor still reads the published one.
  await runCms(
    saveText("home-tagline", {
      ...original.data,
      content: paragraph(EDITED_TAGLINE),
    })
  );
  await openPage(page, "/");
  await expect(page.getByText(EDITED_TAGLINE)).toHaveCount(0);
  await expect(
    page.getByText("Vektorprogrammet arbeider for å øke interessen")
  ).toBeVisible();

  // Publishing makes it the page's text on the next request: nothing is built, deployed or restarted.
  await runCms(publishText("home-tagline"));
  await openPage(page, "/");
  await expect(page.getByText(EDITED_TAGLINE)).toBeVisible();
  await screenshot(page, "public-home-edited");

  // Put the original back (and publish it), so that no later test sees the edit.
  await runCms(saveText("home-tagline", original.data));
  await runCms(publishText("home-tagline"));
  await openPage(page, "/");
  await expect(page.getByText(EDITED_TAGLINE)).toHaveCount(0);
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

test("falsifier 4 (spec 0010a): the contact form posts without JavaScript, and the page that answers still holds the visitor's text", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  // Without Cloudflare's widget script there is no answer to send, whatever the visitor does.
  await page.route("https://challenges.cloudflare.com/**", async (route) => {
    await route.abort();
  });
  const outboxBefore = await runDatabase(outboxRows);

  await page.goto("/kontakt");
  // The control: nothing of React ran in this page, so the form that posts is the markup the server rendered.
  expect(
    await page.evaluate(
      "Object.keys(document.querySelector('form#kontaktskjema') ?? {}).some((key) => key.startsWith('__reactFiber$'))"
    )
  ).toBe(false);
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

  for (const [label, value] of Rec.toEntries(FORM)) {
    await expect(
      page.getByRole("textbox", { exact: true, name: label })
    ).toHaveValue(value);
  }

  expect(await runDatabase(outboxRows)).toEqual(outboxBefore);
  await context.close();
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
}) => {
  const legacyPath = "images/Logo images/e2e-logo.png";
  const url = "/images/Logo%20images/e2e-logo.png";

  const unregistered = await request.get(url, { maxRedirects: 0 });
  expect(unregistered.status()).toBe(404);

  await runDatabase(registerLegacyFile(legacyPath));
  const response = await request.get(url, { maxRedirects: 0 });
  await runDatabase(forgetLegacyFile);

  expect(response.status()).toBe(301);
  expect(response.headers().location).toBe(`/filer/${LEGACY_FILE_KEY}`);
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
