// oxlint-disable effecttsgo/async-function -- EX-0004: Playwright owns these Promise-returning browser callbacks.
import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { LOCAL_FAKE_PASSWORD } from "@vektorprogrammet/domain";
import { Config, Effect, Schema } from "effect";

import { openPage, sheetOf, signIn, submitSheet } from "./support/panel.ts";
import {
  accountStateOf,
  capturedMailTo,
  runDatabase,
} from "./support/probes.ts";

const INVITEE = "mats.medlem@example.org";
const PASSWORD = "et-nytt-testpassord";

const inviteeState = async () => {
  const [account] = await runDatabase(accountStateOf(INVITEE));

  return account?.state;
};

const inviteMailCount = async () => {
  const messages = await runDatabase(capturedMailTo(INVITEE));

  return messages.length;
};

const MailSearch = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ ID: Schema.String })),
});

const MailBody = Schema.Struct({ HTML: Schema.String, Text: Schema.String });

/** Mailpit holds the actual recovery message sent by local Supabase Auth. */
const recoveryLink = async (request: APIRequestContext, recipient: string) => {
  const origin = Effect.runSync(Config.String("E2E_MAILPIT_URL"));
  const mailbox = new URL(origin);

  if (
    mailbox.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(mailbox.hostname)
  ) {
    throw new Error("Mailpit must be local");
  }

  const response = await request.get(`${origin}/api/v1/search`, {
    params: { query: `to:${recipient}` },
  });

  expect(response.ok()).toBe(true);

  const result = await Effect.runPromise(
    Schema.decodeUnknownEffect(MailSearch)(await response.json())
  );

  const id = result.messages[0]?.ID;

  if (id === undefined) {
    return null;
  }

  const message = await request.get(`${origin}/api/v1/message/${id}`);
  expect(message.ok()).toBe(true);

  const body = await Effect.runPromise(
    Schema.decodeUnknownEffect(MailBody)(await message.json())
  );

  return (
    /https?:\/\/[^\s"<>]+/u
      .exec(body.HTML || body.Text)?.[0]
      ?.replaceAll("&amp;", "&") ?? null
  );
};

test("a leader invites a member, who activates and recovers their account", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const { origin } = new URL(test.info().project.use.baseURL ?? "");
  await signIn(page, origin, "lise.leder@example.org", LOCAL_FAKE_PASSWORD);
  await openPage(page, `${origin}/kontrollpanel/team`);
  await page.getByRole("link", { exact: true, name: "Rekruttering" }).click();
  await page
    .getByRole("row")
    .filter({ hasText: "Mats Medlem" })
    .getByRole("button", { name: "Inviter Mats Medlem" })
    .click();
  expect(await submitSheet(page, "Send invitasjon")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  await expect.poll(inviteMailCount).toBeGreaterThan(0);
  const [invitation] = await runDatabase(capturedMailTo(INVITEE));
  const link = /https?:\/\/\S+/u.exec(invitation?.text ?? "")?.[0];
  expect(link).toBeDefined();
  const context = await browser.newContext();
  const member = await context.newPage();
  await openPage(member, link ?? "");
  await member.getByLabel("Nytt passord").fill(PASSWORD);
  await member.getByRole("button", { name: "Aktiver konto" }).click();
  await member.waitForURL(/\/(?:kontrollpanel|min-side)(?:\/|$)/u);
  await expect.poll(inviteeState).toBe("Active");
  await openPage(member, `${origin}/min-side`);
  await member.getByLabel("Navn", { exact: true }).fill("Mats Medlem Test");
  await member.getByRole("button", { name: "Lagre profil" }).click();
  await expect(member.getByLabel("Navn", { exact: true })).toHaveValue(
    "Mats Medlem Test"
  );
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await signIn(other, origin, INVITEE, PASSWORD);
  await member.getByRole("button", { name: "Avslutt andre økter" }).click();
  await expect(
    member.getByRole("status").filter({ hasText: "Andre økter er avsluttet" })
  ).toBeVisible();
  await member.getByLabel("Nåværende passord").fill(PASSWORD);
  await member.getByLabel("Nytt passord").fill("et-endret-testpassord");
  await member.getByRole("button", { name: "Endre passord" }).click();
  await expect(
    member.getByRole("status").filter({ hasText: "Passordet er endret" })
  ).toBeVisible();
  await otherContext.close();
  await context.close();

  const recoveryContext = await browser.newContext();
  const recovery = await recoveryContext.newPage();
  const previousReset = await recoveryLink(request, INVITEE);
  await openPage(recovery, `${origin}/glemt-passord`);
  await recovery.getByLabel("Privat e-post").fill(INVITEE);
  await expect(
    recovery.locator("[name='cf-turnstile-response']")
  ).not.toHaveValue("", { timeout: 30_000 });
  await recovery.getByRole("button", { name: "Send lenke" }).click();
  await expect(recovery.getByRole("status")).toContainText(
    "Hvis en konto finnes"
  );
  let reset: string | null = null;
  await expect
    .poll(async () => {
      reset = await recoveryLink(request, INVITEE);

      return reset !== null && reset !== previousReset;
    })
    .toBe(true);
  await openPage(recovery, reset ?? "");
  await recovery.getByLabel("Nytt passord").fill(LOCAL_FAKE_PASSWORD);
  await recovery.getByRole("button", { name: "Lagre passord" }).click();
  await expect(recovery.getByRole("status")).toContainText(
    "Passordet er endret"
  );
  await signIn(recovery, origin, INVITEE, LOCAL_FAKE_PASSWORD);
  await openPage(recovery, `${origin}/min-side`);
  await expect(
    recovery.getByRole("heading", { name: "Min side" })
  ).toBeVisible();
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signIn(admin, origin, "ada.admin@example.org", LOCAL_FAKE_PASSWORD);
  await openPage(admin, `${origin}/kontrollpanel/personer`);
  await admin
    .getByRole("button", { name: "Deaktiver Mats Medlem Test" })
    .click();
  expect(await submitSheet(admin, "Deaktiver konto")).toBe(200);
  await expect.poll(inviteeState).toBe("Deactivated");
  await openPage(recovery, `${origin}/min-side`);
  await expect(
    recovery.getByRole("heading", { name: "Ikke innlogget" })
  ).toBeVisible();
  await admin
    .getByRole("button", { name: "Reaktiver Mats Medlem Test" })
    .click();
  expect(await submitSheet(admin, "Reaktiver konto")).toBe(200);
  await expect.poll(inviteeState).toBe("Active");
  await signIn(recovery, origin, INVITEE, LOCAL_FAKE_PASSWORD);
  await openPage(recovery, `${origin}/min-side`);
  await recovery.getByLabel("Navn", { exact: true }).fill("Mats Medlem");
  await recovery.getByRole("button", { name: "Lagre profil" }).click();
  await expect(recovery.getByLabel("Navn", { exact: true })).toHaveValue(
    "Mats Medlem"
  );
  await adminContext.close();
  await recoveryContext.close();
});

test("recovery responses do not disclose whether an address exists", async ({
  request,
}) => {
  const { origin } = new URL(test.info().project.use.baseURL ?? "");
  const replies = [];

  for (const email of ["ada.admin@example.org", "not-a-person@example.org"]) {
    const response = await request.post(`${origin}/api/auth/request-reset`, {
      data: { captchaToken: "XXXX.DUMMY.TOKEN.XXXX", email },
      headers: { origin },
    });

    replies.push({ body: await response.text(), status: response.status() });
  }

  expect(replies[0]?.status).toBe(200);
  expect(replies[1]).toEqual(replies[0]);
});
