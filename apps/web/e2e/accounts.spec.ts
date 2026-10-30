/** Spec 0007 falsifier 7, local half: the real Worker, mailbox, PostgreSQL and browser. */
// oxlint-disable effecttsgo/async-function -- EX-0004: Playwright owns these Promise-returning browser callbacks.
import { expect, test } from "@playwright/test";
import { LOCAL_FAKE_PASSWORD } from "@vektorprogrammet/domain";
import { Array as Arr, Clock, Effect } from "effect";

import { CONTACT_RATE_LIMIT } from "../worker.config.ts";
import {
  openPage,
  sheetOf,
  sidebarOf,
  signIn,
  submitSheet,
} from "./support/panel.ts";
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
import { PROBE_BUDGET_MS, windowHasRoom } from "./support/rateLimitWindow.ts";

const INVITEE_EMAIL = "mats.medlem@example.org";
const PASSWORD = "et-nytt-testpassord";
const CHANGED_PASSWORD = "et-endret-testpassord";
const RESET_PASSWORD = "et-tilbakestilt-testpassord";

const inviteeState = async () => {
  const [state] = await runDatabase(accountStateOf(INVITEE_EMAIL));

  return state?.state;
};

test("a leader invites, a member activates and manages their profile and sessions, an admin deactivates", async ({
  page,
  browser,
}) => {
  /**
   * One story with fifteen page loads, each waiting for hydration under `vp dev`. In CI it took 44 to 60 s, and
   * on a slow runner 91 s: the trace of the run that timed out (issue #39) shows every step passing, the
   * hydration waits at 2.4 to 6.8 s each, and the last step finishing at the 90 s limit. The suite's 90 s is the
   * budget of an ordinary test, so this one gets twice that.
   */
  test.setTimeout(180_000);
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

  // The binding counts in fixed windows. Wait until a probe fits in one, then use a bucket nothing else has touched.
  await expect
    .poll(
      () =>
        windowHasRoom(
          Effect.runSync(Clock.currentTimeMillis),
          CONTACT_RATE_LIMIT.period * 1000,
          PROBE_BUDGET_MS
        ),
      { intervals: [250], timeout: CONTACT_RATE_LIMIT.period * 1000 }
    )
    .toBe(true);

  const attempts = [];

  for (const _index of Arr.range(0, CONTACT_RATE_LIMIT.limit)) {
    attempts.push(
      await request.post(`${origin}/api/auth/sign-in/email`, {
        data: {
          email: "ada.admin@example.org",
          password: "incorrect password",
        },
        headers: { "cf-connecting-ip": "192.0.2.78", origin },
      })
    );
  }

  expect(Arr.map(attempts, (response) => response.status())).toEqual([
    ...Arr.replicate(401, CONTACT_RATE_LIMIT.limit),
    429,
  ]);
});

test("falsifier 4 (spec 0010a): the forgot-password form and the code form post without JavaScript", async ({
  browser,
}) => {
  const { origin } = new URL(test.info().project.use.baseURL ?? "");
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  await page.goto(`${origin}/glemt-passord`);
  await page.getByLabel("Privat e-post").fill("privacy-unknown@example.org");

  const reset = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/account/request-reset"
  );

  await page.getByRole("button", { name: "Send lenke" }).click();

  // No script ran, so there is no Turnstile answer: the server refuses in its own words, which shows that the markup
  // alone posted the form to the endpoint that the page names.
  const answeredReset = await reset;

  expect(answeredReset.status()).toBeGreaterThanOrEqual(400);
  expect(await answeredReset.text()).toContain("robot");

  await page.goto(`${origin}/aktiver?kode=c_${"A".repeat(43)}`);
  await page.getByLabel("Nytt passord").fill("a-new-valid-password");

  const activation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/account/activate"
  );

  await page.getByRole("button", { name: "Aktiver og logg inn" }).click();

  // The code is no one's: the answer is the one of a wrong password, so the hidden code and the password both arrived.
  const answeredActivation = await activation;

  expect(answeredActivation.status()).toBe(401);
  await context.close();
});
