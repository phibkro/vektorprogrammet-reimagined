/**
 * Spec 0009 F3, the public journey in a browser, against `vp dev` (the `local` deployment), the real CMS and a database that
 * the importer filled from its fake fixture. An administrator schedules a period that is open now (the control panel's
 * own form); a visitor with no account finds the department on `/soknad`, reads the notice, fills in the form, and
 * sends it with Turnstile's always-pass answer; the mail that the delivery captured carries the link; the link's button
 * verifies the address; the administrator sees the application as verified. The negative control is a second application
 * that nobody verifies: it stays unverified.
 */
// oxlint-disable effecttsgo/async-function -- EX-0004: Playwright owns these Promise-returning browser callbacks.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  TEST_ADMIN,
  fillSheet,
  openPage,
  sheetOf,
  signInAs,
  submitSheet,
} from "./support/panel.ts";
import {
  capturedMailTo,
  closeAdmissionPeriods,
  runDatabase,
} from "./support/probes.ts";

const FIRST = "kari.soknad@example.org";
const SECOND = "ola.soknad@example.org";

test.describe.configure({ mode: "serial" });

// The period that the first test schedules is open for the rest of the run; the home page's "closed" state is another
// spec's claim, so the period ends when this file does.
test.afterAll(async () => {
  await runDatabase(closeAdmissionPeriods);
});

/** The visitor's answers, by the labels of the form. */
const fillApplication = async (page: Page, name: string, email: string) => {
  await page.getByLabel("Navn", { exact: true }).fill(name);
  await page.getByLabel("E-post", { exact: true }).fill(email);
  await page
    .getByRole("combobox", { exact: true, name: "Linje" })
    .selectOption({ index: 1 });

  await page
    .getByRole("combobox", { exact: true, name: "Årstrinn" })
    .selectOption("2");

  await page
    .getByRole("combobox", { exact: true, name: "Bolk" })
    .selectOption("Both");
  await page.getByRole("checkbox", { exact: true, name: "Mandag" }).check();
  await page.getByRole("checkbox", { exact: true, name: "Onsdag" }).check();
};

test("an administrator schedules a period that is open now", async ({
  context,
  page,
}) => {
  await signInAs(context, TEST_ADMIN);
  await openPage(page, "/kontrollpanel/opptak");
  await page.getByRole("button", { name: "Nytt opptak" }).click();

  // The window is wide on purpose: the period is open whenever the spec runs.
  await fillSheet(page, {
    "Slutt (norsk tid)": "2099-12-31T22:00",
    "Start (norsk tid)": "2020-01-01T08:00",
  });

  expect(await submitSheet(page, "Opprett")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: "Åpent" })).toHaveCount(
    1
  );
});

test("F3: a visitor applies, the mailed link verifies the address, and staff see it verified; an unverified one stays so", async ({
  browser,
  context,
  page,
}) => {
  const visitor = await browser.newContext();
  const apply = await visitor.newPage();

  await openPage(apply, "/soknad");
  await expect(apply.getByRole("heading", { level: 1 })).toHaveText(
    "Søk om å bli assistent"
  );

  const link = apply
    .getByRole("navigation", { name: "Åpent opptak" })
    .getByRole("link");

  await expect(link).toHaveCount(1);
  await link.click();
  await expect(apply).toHaveURL(/\/soknad\/[^/?]+$/u);

  // The notice is on the page, from the form's declaration: what is collected, why, for how long.
  await expect(apply.locator("#personvern")).toBeVisible();

  await fillApplication(apply, "Kari Søker", FIRST);
  await apply
    .getByLabel("Spesielle behov (valgfritt)", { exact: true })
    .fill("Trenger ramme");
  // The consent is its own box, unticked by default: the text alone is refused.
  await expect(
    apply.getByRole("checkbox", { name: /Ja, Vektorprogrammet kan lagre/u })
  ).not.toBeChecked();

  // Turnstile's always-pass test key fills in an answer once its widget has run.
  await expect(apply.locator("[name='cf-turnstile-response']")).not.toHaveValue(
    "",
    {
      timeout: 30_000,
    }
  );

  await apply.getByRole("button", { name: "Send søknad" }).click();
  await expect(
    apply.getByText("Spesielle behov lagres bare hvis du samtykker til det.")
  ).toBeVisible();

  await apply
    .getByRole("checkbox", { name: /Ja, Vektorprogrammet kan lagre/u })
    .check();
  await expect(apply.locator("[name='cf-turnstile-response']")).not.toHaveValue(
    "",
    {
      timeout: 30_000,
    }
  );
  await apply.getByRole("button", { name: "Send søknad" }).click();

  await expect(apply).toHaveURL(/\?sendt=1$/u);
  await expect(apply.getByRole("status")).toContainText(
    "Vi har mottatt søknaden din"
  );

  // The mail that the delivery captured carries the one link.
  await expect
    .poll(async () => {
      const messages = await runDatabase(capturedMailTo(FIRST));

      return messages.length;
    })
    .toBe(1);

  const [message] = await runDatabase(capturedMailTo(FIRST));

  const verification = /https?:\/\/\S+\/soknad\/bekreft\?kode=\S+/u.exec(
    message?.text ?? ""
  )?.[0];

  expect(verification).toBeDefined();

  // Opening the link spends nothing: the button does.
  await openPage(apply, verification ?? "");
  await expect(
    apply.getByRole("button", { name: "Bekreft e-postadressen" })
  ).toBeVisible();
  await openPage(apply, verification ?? "");
  await apply.getByRole("button", { name: "Bekreft e-postadressen" }).click();
  await expect(apply.getByRole("status")).toContainText(
    "E-postadressen din er bekreftet"
  );

  // The same link cannot be used twice.
  await openPage(apply, verification ?? "");
  await apply.getByRole("button", { name: "Bekreft e-postadressen" }).click();
  await expect(apply.getByRole("alert")).toBeVisible();

  // The control: a second application that nobody verifies.
  const other = await visitor.newPage();
  await openPage(other, "/soknad");
  await other
    .getByRole("navigation", { name: "Åpent opptak" })
    .getByRole("link")
    .click();
  await fillApplication(other, "Ola Søker", SECOND);
  await expect(other.locator("[name='cf-turnstile-response']")).not.toHaveValue(
    "",
    {
      timeout: 30_000,
    }
  );
  await other.getByRole("button", { name: "Send søknad" }).click();
  await expect(other).toHaveURL(/\?sendt=1$/u);

  // Staff see both, the first verified and the second not.
  await signInAs(context, TEST_ADMIN);
  await openPage(page, "/kontrollpanel/opptak");
  const first = page.getByRole("row").filter({ hasText: FIRST });
  const second = page.getByRole("row").filter({ hasText: SECOND });
  await expect(first).toContainText("Bekreftet");
  await expect(first).not.toContainText("Ikke bekreftet");
  await expect(second).toContainText("Ikke bekreftet");
});
