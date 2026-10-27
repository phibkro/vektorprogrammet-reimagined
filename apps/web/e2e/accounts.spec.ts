/** Spec 0007 falsifier 7, local half: the real Worker, mailbox, PostgreSQL and browser. */
// oxlint-disable effecttsgo/async-function -- EX-0004: Playwright owns these Promise-returning browser callbacks.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { LOCAL_FAKE_PASSWORD } from "@vektorprogrammet/db";
import { Array as Arr } from "effect";

import { openPage, sheetOf, sidebarOf, submitSheet } from "./support/panel.ts";
import {
  accountStateOf,
  capturedMailTo,
  codeFor,
  deactivateResetFixture,
  resetIntentCount,
  runDatabase,
  seedResetCases,
  sessionCountOf,
} from "./support/probes.ts";

const INVITEE_EMAIL = "mats.medlem@example.org";
const PASSWORD = "et-nytt-testpassord";
const CHANGED_PASSWORD = "et-endret-testpassord";
const RESET_PASSWORD = "et-tilbakestilt-testpassord";

const signIn = async (
  page: Page,
  origin: string,
  email: string,
  password: string
) => {
  await openPage(page, `${origin}/logg-inn`);
  await page.getByLabel("E-post", { exact: true }).fill(email);
  await page.getByLabel("Passord", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Logg inn" }).click();
  await page.waitForURL(/\/(?:kontrollpanel|min-side)(?:\/|$)/u);
};

const inviteeState = async () => {
  const [state] = await runDatabase(accountStateOf(INVITEE_EMAIL));

  return state?.state;
};

test("a leader invites, a member activates and manages their profile and sessions, an admin deactivates", async ({
  page,
  browser,
}) => {
  const { origin } = new URL(test.info().project.use.baseURL ?? "");
  await signIn(page, origin, "lise.leder@example.org", LOCAL_FAKE_PASSWORD);
  await openPage(page, `${origin}/kontrollpanel/personer`);
  await page.getByRole("button", { name: "Rediger Mats Medlem" }).click();
  await sheetOf(page)
    .getByLabel("Vektor-e-post")
    .fill("mats@vektorprogrammet.no");
  expect(await submitSheet(page, "Lagre profil")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  await openPage(page, `${origin}/kontrollpanel/team`);
  await page.getByRole("link", { exact: true, name: "Rekruttering" }).click();
  const member = page.getByRole("row").filter({ hasText: "Mats Medlem" });
  await member.getByRole("button", { name: "Inviter Mats Medlem" }).click();
  expect(await submitSheet(page, "Send invitasjon")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  await expect
    .poll(async () => {
      const messages = await runDatabase(capturedMailTo(INVITEE_EMAIL));

      return messages.length;
    })
    .toBeGreaterThan(0);
  const [message] = await runDatabase(capturedMailTo(INVITEE_EMAIL));
  const link = /https?:\/\/\S+/u.exec(message?.text ?? "")?.[0];
  expect(link).toBeDefined();

  const personContext = await browser.newContext();
  const person = await personContext.newPage();
  await openPage(person, link ?? "");
  await person.getByLabel("Nytt passord").fill(PASSWORD);
  await person.getByRole("button", { name: "Aktiver og logg inn" }).click();
  await person.waitForURL(/\/kontrollpanel(?:\/|$)/u);
  await expect(sidebarOf(person).getByRole("link")).toHaveText([
    "Oversikt",
    "Semestre",
    "Team",
    "Arrangementer",
  ]);
  await openPage(person, `${origin}/min-side`);
  await expect(person.getByLabel("Vektor-e-post")).toHaveValue(
    "mats@vektorprogrammet.no"
  );
  await person.getByLabel("Navn", { exact: true }).fill("Mats Medlem Test");
  await person.getByRole("button", { name: "Lagre profil" }).click();
  await expect(person.getByLabel("Navn", { exact: true })).toHaveValue(
    "Mats Medlem Test"
  );

  const secondContext = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
  });

  const second = await secondContext.newPage();
  await signIn(second, origin, INVITEE_EMAIL, PASSWORD);
  await openPage(person, `${origin}/min-side`);
  const sessions = person.getByRole("list", { name: "Aktive økter" });
  await expect(sessions.getByRole("listitem")).toHaveCount(2);
  await expect(sessions).toContainText("Opprettet:");
  await expect(sessions).toContainText("Sist sett:");

  const otherSession = sessions
    .getByRole("listitem")
    .filter({ hasNotText: "Denne økten" });

  await otherSession.getByRole("button", { name: "Avslutt økt" }).click();
  await expect(sessions.getByRole("listitem")).toHaveCount(1);
  expect(await runDatabase(sessionCountOf(INVITEE_EMAIL))).toBe(1);

  await person.getByLabel("Nåværende passord").fill(PASSWORD);
  await person.getByLabel("Nytt passord").fill(CHANGED_PASSWORD);
  await person.getByRole("button", { name: "Endre passord" }).click();
  await expect(
    person.getByRole("status").filter({ hasText: "Passordet er endret." })
  ).toBeVisible();

  await openPage(second, `${origin}/glemt-passord`);
  await second.getByLabel("Privat e-post").fill(INVITEE_EMAIL);
  await expect(
    second.locator("[name='cf-turnstile-response']")
  ).not.toHaveValue("", { timeout: 30_000 });
  await second.getByRole("button", { name: "Send lenke" }).click();
  await expect(second.getByRole("status")).toContainText(
    "Hvis en konto finnes"
  );
  await expect
    .poll(async () => {
      const messages = await runDatabase(capturedMailTo(INVITEE_EMAIL));

      return messages.length;
    })
    .toBe(2);
  const [resetMail] = await runDatabase(capturedMailTo(INVITEE_EMAIL));
  const resetLink = /https?:\/\/\S+/u.exec(resetMail?.text ?? "")?.[0];
  expect(resetLink).toBeDefined();
  await openPage(second, resetLink ?? "");
  await second.getByLabel("Nytt passord").fill(RESET_PASSWORD);
  await second.getByRole("button", { name: "Lagre passord" }).click();
  await second.waitForURL(/\/logg-inn\?/u);
  await signIn(second, origin, INVITEE_EMAIL, RESET_PASSWORD);
  await signIn(person, origin, INVITEE_EMAIL, RESET_PASSWORD);

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signIn(admin, origin, "ada.admin@example.org", LOCAL_FAKE_PASSWORD);
  await openPage(admin, `${origin}/kontrollpanel/personer`);
  await admin
    .getByRole("button", { name: "Deaktiver Mats Medlem Test" })
    .click();
  expect(await submitSheet(admin, "Deaktiver konto")).toBe(200);
  await expect.poll(inviteeState).toBe("Deactivated");
  await openPage(person, `${origin}/min-side`);
  await expect(
    person.getByRole("heading", { name: "Ikke innlogget" })
  ).toBeVisible();

  await admin
    .getByRole("button", { name: "Reaktiver Mats Medlem Test" })
    .click();
  expect(await submitSheet(admin, "Reaktiver konto")).toBe(200);
  await expect.poll(inviteeState).toBe("Active");
  await openPage(person, `${origin}/min-side`);
  await expect(person.getByRole("heading", { name: "Min side" })).toBeVisible();

  await adminContext.close();
  await secondContext.close();
  await personContext.close();
});

test("reset requests have the same HTTP answer for every account state and company address", async ({
  request,
}) => {
  const { origin } = new URL(test.info().project.use.baseURL ?? "");
  await runDatabase(seedResetCases);
  const before = await runDatabase(resetIntentCount);

  const addresses = [
    "privacy-active@example.org",
    "privacy-invited@example.org",
    "privacy-deactivated@example.org",
    "privacy-unknown@example.org",
    "privacy-company@example.org",
  ];

  const replies = [];

  for (const email of addresses) {
    const response = await request.post(`${origin}/api/account/request-reset`, {
      form: { "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX", email },
      headers: { "cf-connecting-ip": "192.0.2.77" },
      maxRedirects: 0,
    });

    replies.push({
      body: await response.body(),
      location: response.headers().location,
      status: response.status(),
    });
  }

  const [first] = replies;
  expect(first?.status).toBe(303);

  for (const reply of replies) {
    expect(reply).toEqual(first);
  }

  expect((await runDatabase(resetIntentCount)) - before).toBe(1);
  await expect
    .poll(async () => {
      const messages = await runDatabase(
        capturedMailTo("privacy-active@example.org")
      );

      return messages.length;
    })
    .toBe(1);

  const [message] = await runDatabase(
    capturedMailTo("privacy-active@example.org")
  );

  const token = /[?&]kode=(?<code>c_[A-Za-z0-9_-]{43})/u.exec(
    message?.text ?? ""
  )?.groups?.code;

  expect(token).toBeDefined();

  const wrong = await request.post(`${origin}/api/auth/sign-in/email`, {
    data: { email: "ada.admin@example.org", password: "incorrect password" },
    headers: { "cf-connecting-ip": "192.0.2.77", origin },
  });

  const wrongBody = await wrong.body();

  const cases = [
    {
      email: "privacy-active@example.org",
      path: "activate",
      purpose: "activation",
    },
    {
      email: "privacy-deactivated@example.org",
      path: "activate",
      purpose: "activation",
    },
    {
      email: "privacy-invited@example.org",
      path: "reset-password",
      purpose: "resetPassword",
    },
    {
      email: "privacy-deactivated@example.org",
      path: "reset-password",
      purpose: "resetPassword",
    },
  ] as const;

  const refusals = [];

  for (const { email, path, purpose } of cases) {
    const code = await runDatabase(codeFor(email, purpose));

    const response = await request.post(`${origin}/api/account/${path}`, {
      form: { code, password: "a-new-valid-password" },
      maxRedirects: 0,
    });

    refusals.push({ body: await response.body(), status: response.status() });
  }

  for (const response of refusals) {
    expect(response.status).toBe(wrong.status());
    expect(response.body).toEqual(wrongBody);
  }

  await runDatabase(deactivateResetFixture);

  const refused = await request.post(`${origin}/api/account/reset-password`, {
    form: { code: token ?? "", password: "a-new-valid-password" },
    maxRedirects: 0,
  });

  expect(refused.status()).toBe(wrong.status());
  expect(await refused.body()).toEqual(wrongBody);

  const attempts = [];

  for (const _index of Arr.range(1, 5)) {
    attempts.push(
      await request.post(`${origin}/api/auth/sign-in/email`, {
        data: {
          email: "ada.admin@example.org",
          password: "incorrect password",
        },
        headers: { "cf-connecting-ip": "192.0.2.77", origin },
      })
    );
  }

  expect(
    Arr.filter(attempts, (response) => response.status() === 401)
  ).toHaveLength(4);
  expect(
    Arr.filter(attempts, (response) => response.status() === 429)
  ).toHaveLength(1);
});
