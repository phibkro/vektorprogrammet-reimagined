/**
 * Spec 0001, journey steps 1 to 4 in a browser, against `vp dev` (the `local` deployment, a test actor chosen
 * by cookie) and a PostgreSQL database that the real importer filled from its fake legacy fixture
 * (`e2e/support/database.ts`): this is migrated data, with the importer's own quirks. The fixture's third
 * department (an invalid e-mail address) is quarantined, its five duplicate semester rows are collapsed to
 * two, and its orphan fields of study are left out. One story over one database, so the tests run in order.
 * Falsifier 5 is the last test: a team leader of department A is refused (403) on department B's field of
 * study, by a request the page itself would never send.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Array as Arr, Order } from "effect";

import {
  chosenOf,
  dialogOf,
  fillDialog,
  nextOsloYear,
  openPage,
  semesterKey,
  semesterLabelsOf,
  signInAs,
  statusOfClick,
  submitDialog,
  tamperWith,
  textOf,
} from "./support/panel.ts";
import {
  auditEntryCount,
  departmentRow,
  departmentsInCity,
  fieldOfStudyNamed,
  fieldOfStudyRow,
  fieldsOfStudyIn,
  runDatabase,
  semesterCount,
} from "./support/probes.ts";

test.describe.configure({ mode: "serial" });

const NOT_ALLOWED = "Du har ikke tilgang til dette.";

const createSemesterButton = (page: Page) =>
  page.getByRole("button", { name: "Opprett semester" });

test("step 1: an administrator sees the migrated departments, creates and edits them, and a repeated city is refused", async ({
  page,
  context,
}) => {
  await signInAs(context, "admin");
  await openPage(page, "/kontrollpanel/avdelinger");

  await expect(page.getByRole("columnheader")).toHaveText([
    "Navn",
    "Kortnavn",
    "By",
    "E-post",
    "Status",
    "Handlinger",
  ]);
  await expect(page.getByRole("row")).toHaveCount(3);
  await expect(
    page.getByRole("row", { name: "Avdeling Alfa" }).getByRole("cell")
  ).toHaveText([
    "Avdeling Alfa",
    "ALFA",
    "Alfaby",
    "kontakt@alfa.example",
    "Aktiv",
    "Rediger",
  ]);
  await expect(
    page.getByRole("row", { name: "Avdeling Beta" }).getByRole("cell")
  ).toHaveText([
    "Avdeling Beta",
    "BETA",
    "Betaby",
    "kontakt@beta.example",
    "Aktiv",
    "Rediger",
  ]);

  // Create an inactive department.
  await page.getByRole("button", { name: "Ny avdeling" }).click();
  await fillDialog(page, {
    By: "Oslo",
    "E-post": "oslo@example.org",
    Kortnavn: "UiO",
    Navn: "Vektor Oslo",
  });
  await dialogOf(page).getByRole("switch", { name: "Aktiv" }).click();
  expect(await submitDialog(page, "Opprett")).toBe(200);
  await expect(dialogOf(page)).toBeHidden();
  await expect(page.getByRole("row", { name: "Vektor Oslo" })).toContainText(
    "Inaktiv"
  );

  // Edit it: the new name shows in the list.
  await page.getByRole("button", { name: "Rediger Vektor Oslo" }).click();
  await fillDialog(page, { Navn: "Vektor Oslo og Akershus" });
  expect(await submitDialog(page, "Lagre")).toBe(200);
  await expect(dialogOf(page)).toBeHidden();
  await expect(
    page.getByRole("row", { name: "Vektor Oslo og Akershus" })
  ).toBeVisible();

  // An edit keeps what the list does not show: address, Slack channel and coordinates.
  await page.getByRole("button", { name: "Rediger Avdeling Alfa" }).click();
  await expect(dialogOf(page).getByLabel("Breddegrad")).toHaveValue("63.4");
  await fillDialog(page, { Navn: "Avdeling Alfa (NTNU)" });
  expect(await submitDialog(page, "Lagre")).toBe(200);
  await expect(dialogOf(page)).toBeHidden();
  expect(await runDatabase(departmentRow(1))).toEqual({
    address: "Alfaveien 1",
    latitude: 63.4,
    longitude: 10.4,
    name: "Avdeling Alfa (NTNU)",
    slackChannel: "#alfa",
  });

  // A city is unique: the refusal is a 409 with the message, the dialog stays, nothing is saved.
  await page.getByRole("button", { name: "Ny avdeling" }).click();
  await fillDialog(page, {
    By: "Alfaby",
    "E-post": "annen@example.org",
    Kortnavn: "ANN",
    Navn: "En annen avdeling",
  });
  expect(await submitDialog(page, "Opprett")).toBe(409);
  await expect(dialogOf(page).getByRole("alert")).toHaveText(
    "Det finnes allerede en avdeling i Alfaby."
  );
  await dialogOf(page).getByRole("button", { name: "Avbryt" }).click();
  await expect(page.getByRole("row", { name: "Alfaby" })).toHaveCount(1);
  expect(await runDatabase(departmentsInCity("Alfaby"))).toBe(1);
});

test("step 2 (RULE-144, RULE-050): the semesters come newest first, the next one is created, a duplicate is refused, the years run 2012 to next year", async ({
  page,
  context,
}) => {
  await signInAs(context, "admin");
  await openPage(page, "/kontrollpanel/semestre");

  // The importer collapsed the fixture's five rows for two semesters; none is listed twice.
  const before = await semesterLabelsOf(page);
  const keys = Arr.map(before, semesterKey);

  expect(before).toEqual(expect.arrayContaining(["Vår 2024", "Høst 2024"]));
  expect(Arr.dedupe(before)).toEqual(before);
  expect(keys).toEqual(Arr.sort(keys, Order.flip(Order.Number)));
  await expect(page.getByText("Nåværende", { exact: true })).toHaveCount(1);

  // The form proposes the next semester; creating it puts it first.
  const term = page.getByRole("combobox", { name: "Semester" });
  const year = page.getByRole("combobox", { name: "År" });
  const termLabel = await chosenOf(term);
  const yearLabel = await chosenOf(year);
  const proposed = `${termLabel} ${yearLabel}`;

  expect(await statusOfClick(page, createSemesterButton(page))).toBe(200);
  await expect(page.getByRole("row").nth(1)).toContainText(proposed);

  const after = await semesterLabelsOf(page);
  const saved = await runDatabase(semesterCount);

  expect(after[0]).toBe(proposed);
  expect(after).toHaveLength(before.length + 1);

  // The same semester again is refused with its name, and nothing is saved.
  await term.click();
  await page.getByRole("option", { exact: true, name: termLabel }).click();
  await year.click();
  await page.getByRole("option", { exact: true, name: yearLabel }).click();

  expect(await statusOfClick(page, createSemesterButton(page))).toBe(409);
  await expect(page.getByRole("alert")).toHaveText(
    `Semesteret ${proposed} finnes allerede`
  );
  expect(await semesterLabelsOf(page)).toEqual(after);
  expect(await runDatabase(semesterCount)).toBe(saved);

  // The years offered run from next year down to 2012, with none missing.
  const newestYear = nextOsloYear();

  await year.click();
  await expect(page.getByRole("option")).toHaveText(
    Arr.makeBy(newestYear - 2012 + 1, (offset) => String(newestYear - offset))
  );
});

test("step 3 (RULE-139): a team leader lists, creates and renames the fields of study of their own department only", async ({
  page,
  context,
}) => {
  await signInAs(context, "teamLeader");
  await openPage(page, "/kontrollpanel/linjer");

  await expect(page.getByText("Avdeling Alfa").first()).toBeVisible();
  await expect(page.getByRole("row", { name: "Fag Alfa" })).toBeVisible();
  await expect(page.getByRole("row", { name: "Fag Beta" })).toHaveCount(0);

  await page.getByRole("button", { name: "Ny linje" }).click();
  await fillDialog(page, { Kortnavn: "MA", Navn: "Matematikk" });
  expect(await submitDialog(page, "Opprett")).toBe(200);
  await expect(dialogOf(page)).toBeHidden();
  await expect(page.getByRole("row", { name: "Matematikk" })).toBeVisible();

  await page
    .getByRole("button", { name: "Gi nytt navn til Matematikk" })
    .click();
  await fillDialog(page, { Navn: "Matematikk og statistikk" });
  expect(await submitDialog(page, "Lagre")).toBe(200);
  await expect(dialogOf(page)).toBeHidden();
  await expect(
    page.getByRole("row", { name: "Matematikk og statistikk" })
  ).toBeVisible();
  expect(
    await runDatabase(fieldOfStudyNamed("Matematikk og statistikk"))
  ).toEqual({ departmentId: 1, name: "Matematikk og statistikk" });
});

test("step 4: the dashboard, the semester list and the events form name the same current semester", async ({
  page,
  context,
}) => {
  await signInAs(context, "admin");
  await openPage(page, "/kontrollpanel");

  const dashboard = await textOf(page.getByText(/^Nåværende semester:/u));
  const current = dashboard.replace("Nåværende semester:", "").trim();

  await openPage(page, "/kontrollpanel/semestre");
  await expect(
    page
      .getByRole("row")
      .filter({ has: page.getByText("Nåværende", { exact: true }) })
  ).toContainText(current);

  await openPage(page, "/kontrollpanel/arrangementer");
  await expect(page.locator("select#semesterId option:checked")).toHaveText(
    current
  );
});

test("falsifier 5 (RULE-139): a team leader from department A is refused (403) on department B's field of study, with nothing changed", async ({
  page,
  context,
}) => {
  await signInAs(context, "teamLeader");
  await openPage(page, "/kontrollpanel/linjer");

  const departmentBFields = await runDatabase(fieldsOfStudyIn(2));
  const audited = await runDatabase(auditEntryCount);

  // The rename form of A's field of study, with the hidden id changed to B's (2).
  await page.getByRole("button", { name: "Gi nytt navn til Fag Alfa" }).click();
  await tamperWith(page, "id", "2");
  await fillDialog(page, { Navn: "Kapret" });
  expect(await submitDialog(page, "Lagre")).toBe(403);
  await expect(dialogOf(page).getByRole("alert")).toHaveText(NOT_ALLOWED);
  await dialogOf(page).getByRole("button", { name: "Avbryt" }).click();

  // The create form of A, with the hidden department changed to B's (2).
  await page.getByRole("button", { name: "Ny linje" }).click();
  await tamperWith(page, "departmentId", "2");
  await fillDialog(page, { Kortnavn: "SN", Navn: "Snikopprettet" });
  expect(await submitDialog(page, "Opprett")).toBe(403);
  await expect(dialogOf(page).getByRole("alert")).toHaveText(NOT_ALLOWED);

  expect(await runDatabase(fieldOfStudyRow(2))).toEqual({
    departmentId: 2,
    name: "Fag Beta",
  });
  expect(await runDatabase(fieldsOfStudyIn(2))).toBe(departmentBFields);
  expect(await runDatabase(auditEntryCount)).toBe(audited);
});
