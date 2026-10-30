/**
 * Spec 0027 F10 and F9, the journey of an administrator on the running app: the page `Effekt` lists an ended semester
 * with the three measures and their definitions, every cell says that placement is not built (nothing is estimated and
 * no zero stands in for it), the CSV is saved by the browser (its content is `impactCsv`'s, tested in the domain), and a
 * leader, who holds no `listImpact`, gets 403.
 */
// oxlint-disable effecttsgo/async-function -- EX-0004: Playwright owns these Promise-returning browser callbacks.
import { expect, test } from "@playwright/test";
import { Array as Arr, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import {
  TEST_ADMIN,
  TEST_LEADER,
  openPage,
  signInAs,
} from "./support/panel.ts";
import { runDatabase } from "./support/probes.ts";

const PATH = "/kontrollpanel/effekt";

const REASON = "placement is not built (spec 0011)";

test("an administrator reads the measures with every cell unavailable for the stated reason, and saves the CSV", async ({
  context,
  page,
}) => {
  // A semester that has ended, so that the page has a table: the importer's fixture need not hold one.
  await runDatabase(
    Effect.flatMap(
      SqlClient,
      (sql) =>
        sql`insert into semester (term, year) values ('VAR', 2018) on conflict do nothing`
    )
  );

  await signInAs(context, TEST_ADMIN);
  await openPage(page, PATH);

  await expect(
    page.getByRole("heading", { level: 1, name: "Effekt" })
  ).toBeVisible();

  await expect(
    page.getByRole("heading", { level: 2, name: "Vår 2018" })
  ).toBeVisible();

  // The three measures, each with its definition in words.
  await expect(
    page.getByText("Assistenter plassert", { exact: true }).first()
  ).toBeVisible();

  await expect(
    page.getByText("Plasseringer", { exact: true }).first()
  ).toBeVisible();

  await expect(
    page.getByText("Skoler besøkt", { exact: true }).first()
  ).toBeVisible();

  await expect(
    page.getByText("en person som er plassert to ganger telles én gang").first()
  ).toBeVisible();

  // Every cell of the semester is unavailable, with the reason: no number, no zero.
  const semesterCard = page
    .locator("div")
    .filter({ has: page.getByRole("heading", { level: 2, name: "Vår 2018" }) })
    .last();

  await expect(
    semesterCard.getByText(`Utilgjengelig: ${REASON}`).first()
  ).toBeVisible();

  const cells = await semesterCard.getByRole("cell").allTextContents();

  expect(Arr.filter(cells, (text) => /^\d+$/u.test(text.trim()))).toEqual([]);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Last ned CSV" }).click(),
  ]);

  expect(download.suggestedFilename()).toBe("effekt.csv");
  expect(await download.failure()).toBeNull();
});

test("a leader, who holds no listImpact, gets 403 for the page", async ({
  context,
  page,
}) => {
  await signInAs(context, TEST_LEADER);
  const response = await page.goto(PATH);

  expect(response?.status()).toBe(403);
});
