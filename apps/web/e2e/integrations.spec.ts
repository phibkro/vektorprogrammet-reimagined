import { expect, test } from "@playwright/test";

import {
  TEST_ADMIN,
  TEST_LEADER,
  fillSheet,
  openPage,
  sheetOf,
  startNewTeam,
  signInAs,
  submitSheet,
} from "./support/panel.ts";
import {
  completedWorkspaceRequestCount,
  runDatabase,
  workspaceRequestCount,
} from "./support/probes.ts";

const PATH = "/kontrollpanel/integrasjoner";

test("an administrator requests a dry-run and reads the resulting report", async ({
  context,
  page,
}) => {
  await signInAs(context, TEST_ADMIN);
  // Configure an actual team through the same create and edit commands the report consumes.
  await startNewTeam(page);
  await fillSheet(page, {
    "Google-gruppeadresse": "integration@vektorprogrammet.no",
    Navn: "Integrasjonsteam",
  });
  expect(await submitSheet(page, "Opprett")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  await page
    .getByRole("link", { exact: true, name: "Integrasjonsteam" })
    .click();
  await page.getByRole("button", { name: "Rediger team" }).click();
  await fillSheet(page, {
    "Google-gruppeadresse": "integration-updated@vektorprogrammet.no",
  });
  expect(await submitSheet(page, "Lagre")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  await openPage(page, PATH);
  await expect(
    page.getByRole("heading", { level: 1, name: "Integrasjoner" })
  ).toBeVisible();
  await expect(page.getByText("Skrivemodus:")).toContainText("Av");
  // Spec 0008b: what the outbox has not delivered is on this page, by state, never with a message's content.
  await expect(
    page.getByRole("heading", { name: "Utsendelser" })
  ).toBeVisible();
  await expect(
    page.getByText(/Levert: \d+ · Venter: \d+ · Mislyktes: \d+/u)
  ).toBeVisible();

  const requests = await runDatabase(workspaceRequestCount);
  const completed = await runDatabase(completedWorkspaceRequestCount);
  await page.getByRole("button", { name: "Bestill prøverapport" }).click();
  expect(await submitSheet(page, "Bestill rapport")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  expect(await runDatabase(workspaceRequestCount)).toBe(requests + 1);

  // Exercise the Worker's real scheduled handler rather than a test-only job runner.
  const scheduled = await page.request.get("/cdn-cgi/handler/scheduled");
  expect(scheduled.ok()).toBe(true);
  await expect
    .poll(async () => await runDatabase(completedWorkspaceRequestCount))
    .toBe(completed + 1);
  await openPage(page, PATH);
  await expect(
    page.getByRole("heading", { name: "Siste rapport" })
  ).toBeVisible();
  await expect(page.getByText(/Status: complete/u)).toContainText("dry-run");
  await expect(
    page.getByRole("heading", { level: 2, name: "Grupper" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Kontoer" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ønskede avdelingslister" })
  ).toBeVisible();
  await expect(
    page.getByText("integration-updated@vektorprogrammet.no")
  ).toBeVisible();
});

test("a team leader cannot open the administrator's integration report", async ({
  context,
}) => {
  await signInAs(context, TEST_LEADER);
  const refused = await context.request.get(PATH);
  expect(refused.status()).toBe(403);
});
