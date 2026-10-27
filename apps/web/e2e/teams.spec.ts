/** Spec 0006, falsifier 10: the real control panel, its server functions and migrated PostgreSQL. */
// oxlint-disable effecttsgo/async-function -- EX-0004: Playwright owns these Promise-returning browser callbacks.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { LOCAL_PEOPLE } from "@vektorprogrammet/db";
import { Array as Arr } from "effect";

import {
  TEST_ADMIN,
  TEST_LEADER,
  fillSheet,
  openPage,
  sheetOf,
  sidebarOf,
  signInAs,
  registerPerson,
  submitSheet,
  textOf,
} from "./support/panel.ts";
import { membershipsNamed, runDatabase } from "./support/probes.ts";

const TEAM = "Dokumentasjonsteam";
const EXTEND = "Emma Utvider";
const CHANGE = "Kaja Endrer";
const END = "Einar Avslutter";

const memberRow = (page: Page, name: string) =>
  page.getByRole("row").filter({ hasText: name });

/** Register a person in the imported first department, and wait until the page lists them. */
const register = async (page: Page, name: string, email: string) => {
  await registerPerson(page, name, email);
  await expect(memberRow(page, name)).toBeVisible();
};

/** Give a person the current semester and the team's default end. */
const addMember = async (page: Page, name: string) => {
  await page.getByRole("button", { name: "Legg til medlem" }).click();
  await sheetOf(page).getByLabel("Person").selectOption({ label: name });
  await sheetOf(page).getByLabel("Stilling").selectOption({ label: "Medlem" });
  expect(await submitSheet(page, "Legg til")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  await expect(memberRow(page, name)).toContainText("Aktiv");
};

test("falsifier 10: an admin and leader create a team and members, switch principal, extend, change and end memberships", async ({
  page,
  context,
}) => {
  await signInAs(context, TEST_ADMIN);
  await openPage(page, "/kontrollpanel/team");
  await page.getByRole("button", { name: "Nytt team" }).click();
  await sheetOf(page).getByLabel("Avdeling").selectOption("1");
  await fillSheet(page, { Navn: TEAM });
  await sheetOf(page)
    .getByLabel("Funksjon")
    .selectOption({ label: "Rekruttering" });
  await sheetOf(page)
    .getByLabel("Standardperiode (semestre)")
    .selectOption("2");
  expect(await submitSheet(page, "Opprett")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  await expect(
    page.getByRole("link", { exact: true, name: TEAM })
  ).toBeVisible();

  await openPage(page, "/kontrollpanel/personer");
  await register(page, EXTEND, "emma.extend@example.org");
  await register(page, CHANGE, "kaja.change@example.org");
  await register(page, END, "einar.end@example.org");

  await signInAs(context, TEST_LEADER);
  await openPage(page, "/kontrollpanel/team");
  await page.getByRole("link", { exact: true, name: TEAM }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: TEAM })
  ).toBeVisible();
  const teamPath = new URL(page.url()).pathname;

  await addMember(page, EXTEND);
  await addMember(page, CHANGE);
  await addMember(page, END);
  const beforeExtend = await runDatabase(membershipsNamed(TEAM, EXTEND));
  const beforeChange = await runDatabase(membershipsNamed(TEAM, CHANGE));
  const beforeEnd = await runDatabase(membershipsNamed(TEAM, END));
  expect(beforeExtend).toHaveLength(1);
  expect(beforeChange).toHaveLength(1);
  expect(beforeEnd).toHaveLength(1);

  // Select the new person with the actual local switch, not a separate role assignment.
  await openPage(page, "/kontrollpanel");
  await page.getByRole("button", { exact: true, name: EXTEND }).click();
  await expect(
    page.getByText(`${EXTEND}, teammedlem`, { exact: true })
  ).toBeVisible();
  await expect(sidebarOf(page).getByRole("link")).toHaveText([
    "Oversikt",
    "Semestre",
    "Team",
    "Arrangementer",
  ]);
  await sidebarOf(page)
    .getByRole("link", { exact: true, name: "Team" })
    .click();
  await expect(page.getByRole("button", { name: "Nytt team" })).toHaveCount(0);
  await page.getByRole("link", { exact: true, name: TEAM }).click();
  await expect(
    memberRow(page, EXTEND).getByRole("button", { name: `Avslutt ${EXTEND}` })
  ).toBeVisible();
  await expect(
    memberRow(page, CHANGE).getByRole("button", { name: `Avslutt ${CHANGE}` })
  ).toHaveCount(0);

  // Switch back to the leader and open the exact extend link sent in an ending-soon digest.
  await openPage(page, "/kontrollpanel");
  await page.getByRole("button", { exact: true, name: TEST_LEADER }).click();
  await expect(
    page.getByText(`${TEST_LEADER}, teamleder`, { exact: true })
  ).toBeVisible();
  await openPage(page, teamPath);
  await memberRow(page, EXTEND)
    .getByRole("button", { name: `Forleng ${EXTEND}` })
    .click();
  const id = await sheetOf(page).locator('input[name="id"]').inputValue();
  await sheetOf(page).getByRole("button", { name: "Avbryt" }).click();
  await openPage(page, `${teamPath}?forleng=${id}`);
  await expect(
    sheetOf(page).getByRole("heading", { name: `Forleng ${EXTEND}` })
  ).toBeVisible();

  const newEnd = await textOf(
    sheetOf(page).getByLabel("Ny slutt").locator("option:checked")
  );

  expect(await submitSheet(page, "Forleng")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  await expect(memberRow(page, EXTEND)).toContainText(newEnd);
  const afterExtend = await runDatabase(membershipsNamed(TEAM, EXTEND));
  expect(afterExtend).toHaveLength(1);
  expect([afterExtend[0]?.endTerm, afterExtend[0]?.endYear]).not.toEqual([
    beforeExtend[0]?.endTerm,
    beforeExtend[0]?.endYear,
  ]);

  // The old row remains as history; a new planned row starts with the changed position.
  await memberRow(page, CHANGE)
    .getByRole("button", { name: `Endre ${CHANGE}` })
    .click();
  await sheetOf(page).getByLabel("Stilling").selectOption({ label: "Leder" });
  expect(await submitSheet(page, "Endre")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  await expect(memberRow(page, CHANGE)).toHaveCount(2);
  await expect(
    memberRow(page, CHANGE).filter({ hasText: "Planlagt" })
  ).toContainText("Leder");
  const afterChange = await runDatabase(membershipsNamed(TEAM, CHANGE));
  expect(afterChange).toHaveLength(2);
  expect(afterChange[0]?.id).toBe(beforeChange[0]?.id);
  expect(afterChange[1]?.position).toBe("Leder");

  // Ending the third membership shortens its term rather than deleting its history.
  await memberRow(page, END)
    .getByRole("button", { name: `Avslutt ${END}` })
    .click();
  expect(await submitSheet(page, "Avslutt")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  const afterEnd = await runDatabase(membershipsNamed(TEAM, END));
  expect(afterEnd).toHaveLength(1);
  expect(afterEnd[0]?.id).toBe(beforeEnd[0]?.id);
  expect([afterEnd[0]?.endTerm, afterEnd[0]?.endYear]).not.toEqual([
    beforeEnd[0]?.endTerm,
    beforeEnd[0]?.endYear,
  ]);
});

// The last two local fixtures have no team and an ended membership, respectively.
for (const person of Arr.take(Arr.drop(LOCAL_PEOPLE, 4), 2)) {
  test(`no current grant: ${person}`, async ({ page, context }) => {
    await signInAs(context, person);
    await openPage(page, "/kontrollpanel");
    await expect(
      page.getByRole("heading", { level: 1, name: "Ingen tilgang" })
    ).toBeVisible();
    await expect(sidebarOf(page)).toHaveCount(0);
    await expect(
      page.getByText(person, { exact: false }).first()
    ).toBeVisible();
  });
}
