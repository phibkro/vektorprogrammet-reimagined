/**
 * Spec 0007b, the browser journey against the real Worker, PostgreSQL and the capture mailbox: a signed-in person answers
 * both alumni questions and downloads their own data; the link of the alumni e-mail answers without signing in, and a
 * wrong code answers nothing; an administrator merges two records of one person; the nightly retention cron, run through
 * the Worker's own `scheduled` handler, anonymises an expired person and audits counts only; and the contact form shows
 * the privacy notice that the declarations generate.
 */
// oxlint-disable effecttsgo/async-function -- EX-0004: Playwright owns these Promise-returning browser callbacks.
import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import {
  Catalog,
  ContactForm,
  LOCAL_FAKE_PASSWORD,
  Periods,
  codePolicy,
  draftNote,
  durationWords,
  lifetimeWords,
  privacyNotice,
  privacyText,
} from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Order, Schema } from "effect";

import { ANONYMOUS_CHOICE } from "../src/lib/testActor.ts";
import { RETENTION_CRON } from "../worker.config.ts";
import {
  TEST_ADMIN,
  openPage,
  registerPerson,
  sheetOf,
  signIn,
  signInAs,
  statusOfClick,
  submitSheet,
  tamperWith,
} from "./support/panel.ts";
import {
  auditEntryCount,
  capturedMailTo,
  consentsOf,
  insertExpiredPerson,
  jobRunCount,
  latestRetentionCounts,
  personCore,
  personIdOf,
  runDatabase,
} from "./support/probes.ts";

const NORA = "nora.nybegynner@example.org";
const EVA = "eva.ekstern@example.org";
const ADA = "ada.admin@example.org";
const SOFIE = "sofie.styre@example.org";

/** What a downloaded file holds that these tests read: whose it is and its rows by table. */
const ExportFile = Schema.Struct({
  personId: Schema.Int,
  tables: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
  ),
});

const decodeExportFile = Schema.decodeEffect(Schema.fromJsonString(ExportFile));

const originOf = () => new URL(test.info().project.use.baseURL ?? "").origin;

/**
 * A page of a browser context of its own whose actor is nobody. Without the cookie the local stack acts as Ada Admin
 * (`ANONYMOUS_CHOICE` chooses nobody), and Ada's grants would hide a code that opened too much.
 */
const visitorPage = async (browser: Browser) => {
  const context = await browser.newContext();
  await signInAs(context, ANONYMOUS_CHOICE);

  return await context.newPage();
};

/** One of the two questions, as a person finds it: a group named by its heading. */
const question = (page: Page, title: string) =>
  page.getByRole("group", { name: title });

/** How many messages the capture mailbox holds for an address. */
const mailCountTo = async (recipient: string) => {
  const messages = await runDatabase(capturedMailTo(recipient));

  return messages.length;
};

/** Whether the person's core fields were anonymised. */
const isAnonymised = async (id: number) => {
  const core = await runDatabase(personCore(id));

  return core.anonymised;
};

const KEEP = "Behold opplysningene mine";
const NEWS = "Nyheter for tidligere medlemmer";

test("a signed-in person answers both questions on Min side and downloads their own data, and only theirs", async ({
  page,
}) => {
  const origin = originOf();
  await signIn(page, origin, NORA, LOCAL_FAKE_PASSWORD);
  await openPage(page, `${origin}/min-side`);

  const keep = question(page, KEEP);
  const news = question(page, NEWS);
  await expect(keep).toContainText("Svaret ditt nå: ikke besvart");
  await expect(news).toContainText("Svaret ditt nå: ikke besvart");
  expect(await runDatabase(consentsOf(NORA))).toEqual([]);

  // One click answers one question; the other stays as it was.
  await keep.getByRole("button", { exact: true, name: "Ja" }).click();
  await expect(keep).toContainText("Svaret ditt nå: Ja");
  await expect(news).toContainText("Svaret ditt nå: ikke besvart");
  await news.getByRole("button", { exact: true, name: "Nei" }).click();
  await expect(news).toContainText("Svaret ditt nå: Nei");

  // A "no" is a record too: it was asked, which text was seen, and when. Both name the current version of the text.
  expect(await runDatabase(consentsOf(NORA))).toEqual([
    { kind: "keepDetails", textVersion: 1, withdrawn: false },
    { kind: "news", textVersion: 1, withdrawn: true },
  ]);

  await openPage(page, `${origin}/min-side`);
  await expect(keep).toContainText("Svaret ditt nå: Ja");
  await expect(news).toContainText("Svaret ditt nå: Nei");

  // The file is saved by the browser, holds the person's rows and nobody else's, and the export is audited.
  const audited = await runDatabase(auditEntryCount);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Last ned opplysningene mine" }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(
    /^vektorprogrammet-mine-data-\d+\.json$/u
  );
  expect(await download.failure()).toBeNull();

  // The same route answers a request with the page's own cookies: its body is the text of the file that was saved.
  // A page's own post carries its origin. The CSRF middleware (`src/start.ts`) answers 403 to a POST without one, so it is sent.
  const response = await page.request.post(`${origin}/api/eksport`, {
    headers: { origin },
  });

  expect(response.status()).toBe(200);
  expect(response.headers()["content-disposition"]).toContain("attachment");
  const text = await response.text();
  const file = await Effect.runPromise(decodeExportFile(text));

  expect(file.personId).toBe(await runDatabase(personIdOf(NORA)));
  expect(Arr.map(file.tables.person ?? [], (row) => row.email)).toEqual([NORA]);

  expect(
    Arr.sort(
      Arr.map(file.tables.consent ?? [], (row) => String(row.kind)),
      Order.String
    )
  ).toEqual(["keepDetails", "news"]);

  for (const other of [
    "Ada Admin",
    "Lise Leder",
    "Mats Medlem",
    "Sofie Styre",
    "Eva Ekstern",
  ]) {
    expect(text).not.toContain(other);
  }

  // No credential hash is in the file (bcrypt hashes start `$2a$`, `$2b$` or `$2y$`).
  expect(text).not.toMatch(/\$2[aby]\$/u);
  // One audit row for each of the two exports.
  expect(await runDatabase(auditEntryCount)).toBe(audited + 2);
});

test("an administrator's Min side answers only for themself: a person id forged into the form is refused, and nothing is written for the other person", async ({
  page,
}) => {
  const origin = originOf();
  await signIn(page, origin, ADA, LOCAL_FAKE_PASSWORD);
  await openPage(page, `${origin}/min-side`);

  const other = await runDatabase(personIdOf(SOFIE));
  const keep = question(page, KEEP);
  const yes = keep.getByRole("button", { exact: true, name: "Ja" });

  // As a person with the browser's developer tools would: the call carries the administrator's own form, and the person id
  // in it is another person's. The grant table admits an administrator for every person, so only the command can refuse it.
  await tamperWith(page, "personId", String(other));

  expect(await statusOfClick(page, yes)).toBe(403);
  await expect(keep.getByRole("alert")).toContainText(
    "Du har ikke tilgang til dette."
  );
  expect(await runDatabase(consentsOf(SOFIE))).toEqual([]);

  // The same click in the administrator's own form is allowed: the refusal is about whose answer it is.
  await openPage(page, `${origin}/min-side`);
  expect(await statusOfClick(page, yes)).toBe(200);
  await expect(keep).toContainText("Svaret ditt nå: Ja");

  expect(await runDatabase(consentsOf(ADA))).toContainEqual({
    kind: "keepDetails",
    textVersion: 1,
    withdrawn: false,
  });

  expect(await runDatabase(consentsOf(SOFIE))).toEqual([]);
});

test("the link of the alumni e-mail answers without signing in, answers again, and a wrong code answers nothing", async ({
  browser,
  request,
}) => {
  const origin = originOf();

  // The tick ran once when the stack started and asked Eva, who left last semester. Running it again asks nobody twice.
  await request.get(`${origin}/cdn-cgi/handler/scheduled`);

  await expect.poll(async () => await mailCountTo(EVA)).toBe(1);

  const [mail] = await runDatabase(capturedMailTo(EVA));

  const link = /https?:\/\/\S+\/alumni\?kode=c_[A-Za-z0-9_-]{43}/u.exec(
    mail?.text ?? ""
  )?.[0];

  expect(link).toBeDefined();
  // The mail's own sentence: the declared lifetime of the code, spelled by `lifetimeWords` as the mail spells it.
  expect(mail?.text).toContain(
    `Lenken virker i ${lifetimeWords(codePolicy.alumniConsent.lifetimeSeconds, "no")}`
  );

  const visitor = await visitorPage(browser);
  await openPage(visitor, link ?? "");
  await expect(
    visitor.getByRole("heading", {
      level: 1,
      name: "Takk for innsatsen i Vektorprogrammet",
    })
  ).toBeVisible();

  const news = question(visitor, NEWS);
  await news.getByRole("button", { exact: true, name: "Ja" }).click();
  await expect(news.getByRole("status")).toHaveText("Svaret ditt er lagret.");

  expect(await runDatabase(consentsOf(EVA))).toEqual([
    { kind: "news", textVersion: 1, withdrawn: false },
  ]);

  // The same link answers again: the answer can be corrected, and the first answer stays on record as given.
  await news.getByRole("button", { exact: true, name: "Nei" }).click();

  await expect
    .poll(async () => {
      const [record] = await runDatabase(consentsOf(EVA));

      return record?.withdrawn;
    })
    .toBe(true);

  // Negative control: a code that was never minted answers nothing, and says so. The refusal is the server's, a real 403
  // that the click made (a click that made no request fails on that, and not on a missing message), and the form of the
  // button that was clicked shows it.
  const forged = await visitorPage(browser);
  await openPage(forged, `${origin}/alumni?kode=c_${"A".repeat(43)}`);

  const keep = question(forged, KEEP);
  expect(
    await statusOfClick(
      forged,
      keep.getByRole("button", { exact: true, name: "Ja" })
    )
  ).toBe(403);
  await expect(keep.getByRole("alert")).toContainText(
    "Du har ikke tilgang til dette."
  );

  expect(await runDatabase(consentsOf(EVA))).toEqual([
    { kind: "news", textVersion: 1, withdrawn: true },
  ]);

  // The code is no session: without one, the download of someone's data is refused.
  const refused = await visitor.request.post(`${origin}/api/eksport`, {
    headers: { origin },
  });

  expect(refused.status()).toBe(403);
  expect(await refused.text()).toBe("Du har ikke tilgang til dette.");
  expect(refused.headers()["content-disposition"]).toBeUndefined();
});

test("an administrator merges two records of one person: the second becomes a tombstone without personal data", async ({
  context,
  page,
}) => {
  const NAME = "Dobbel Person";
  const FIRST = "dobbel.en@example.org";
  const SECOND = "dobbel.to@example.org";

  await signInAs(context, TEST_ADMIN);
  await openPage(page, "/kontrollpanel/personer");
  await registerPerson(page, NAME, FIRST);
  await registerPerson(page, NAME, SECOND);
  const rows = page.getByRole("row").filter({ hasText: NAME });
  await expect(rows).toHaveCount(2);

  const first = await runDatabase(personIdOf(FIRST));
  const second = await runDatabase(personIdOf(SECOND));

  await page.getByRole("button", { name: "Slå sammen personer" }).click();

  await sheetOf(page)
    .getByLabel("Personen som blir stående")
    .selectOption({ label: `${NAME} (${FIRST})` });

  await sheetOf(page)
    .getByLabel("Personen som slås sammen inn i den")
    .selectOption({ label: `${NAME} (${SECOND})` });

  expect(await submitSheet(page, "Slå sammen")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();

  // The list shows one person; the other record is a tombstone that names the survivor and holds no name or address.
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(FIRST);

  const tombstone = await runDatabase(personCore(second));
  expect(tombstone.anonymised).toBe(true);
  expect(tombstone.mergedInto).toBe(first);
  expect(tombstone.email).toBe(
    `anonymisert-${second}@vektorprogrammet.invalid`
  );
  expect(tombstone.name).not.toContain("Dobbel");

  const survivor = await runDatabase(personCore(first));
  expect(survivor).toEqual({
    anonymised: false,
    email: FIRST,
    mergedInto: null,
    name: NAME,
  });

  // An administrator can erase anyone on their behalf: this is how a person with no account is erased.
  await page
    .getByRole("button", { name: `Slett opplysningene til ${NAME}` })
    .click();

  expect(await submitSheet(page, "Slett opplysningene")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  await expect(rows).toHaveCount(0);

  const erased = await runDatabase(personCore(first));
  expect(erased.anonymised).toBe(true);
  expect(erased.email).toBe(`anonymisert-${first}@vektorprogrammet.invalid`);
  expect(erased.name).not.toContain("Dobbel");
});

test("the nightly retention cron anonymises an expired person, and its audit row holds counts and no value", async ({
  request,
}) => {
  const NAME = "Gammel Gunnar";
  const EMAIL = "gammel.gunnar@example.org";
  const id = await runDatabase(insertExpiredPerson(NAME, EMAIL));
  expect(await isAnonymised(id)).toBe(false);

  // The plain trigger that other tests pull runs the ten-minute tick, which has no retention job: only the retention
  // cron string runs it, so the scheduler's ledger holds no run of it yet.
  expect(await runDatabase(jobRunCount("retention"))).toBe(0);

  // The Worker's own `scheduled` handler, with the retention cron: the dispatch on `controller.cron` is what runs. This
  // stack is a local deployment, which applies the run (`retention.ran`); production only counts while a period is a
  // proposal, which `apps/web/test/retentionJob.postgres.test.ts` runs through `runTick` with this cron in each deployment.
  const ran = await request.get(
    `${originOf()}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(RETENTION_CRON)}`
  );

  expect(ran.ok()).toBe(true);

  await expect.poll(async () => await isAnonymised(id)).toBe(true);

  // The run is a registered job like the others: the ledger holds it, once.
  await expect
    .poll(async () => await runDatabase(jobRunCount("retention")))
    .toBe(1);

  const after = await runDatabase(personCore(id));
  expect(after.email).toBe(`anonymisert-${id}@vektorprogrammet.invalid`);
  expect(after.name).not.toContain("Gunnar");

  const { counts } = await runDatabase(latestRetentionCounts);
  expect(counts.person).toBeGreaterThanOrEqual(1);
  // Integers per table: nothing in the row names the person.
  expect(JSON.stringify(counts)).not.toMatch(/gunnar|gammel/iu);
});

test("the contact form shows the privacy notice that the declarations generate", async ({
  page,
}) => {
  await openPage(page, "/kontakt");

  const notice = page.locator("form#kontaktskjema").getByRole("region", {
    name: "Personvern",
  });

  await expect(notice).toBeVisible();
  await expect(notice).toContainText(privacyText.controller.no);

  // The four personal fields of the form are kept the same way, so they read as one entry; the department that the
  // visitor picks is the organisation's own and is not in the notice.
  const items = notice.getByRole("listitem");
  await expect(items).toHaveCount(1);

  await Promise.all(
    Arr.map(
      ["Navnet ditt", "E-postadressen din", "Emnet", "Meldingen din"],
      async (label) => {
        await expect(items).toContainText(label);
      }
    )
  );

  // The period is the declared one (approving or changing it is one line in the domain), not a number written here.
  await expect(items).toContainText(
    `Lagres: ${durationWords(Periods.outboxRows.duration, "no")}`
  );

  // The page says what awaits the operator and only that: the sentence from the declarations, or no note when nothing does.
  const { open } = privacyNotice(ContactForm, Catalog);
  const note = draftNote(open, "no");
  const shown = notice.getByRole("note");

  await (note === undefined
    ? expect(shown).toHaveCount(0)
    : expect(shown).toHaveText(note));
});
