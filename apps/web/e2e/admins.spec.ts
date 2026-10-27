/**
 * Issue 26 (spec 0006 R9): the control panel's one refusal that names a hidden input. The revoke sheet holds only a
 * hidden `id`, so the domain's refusal of the last lasting admin place has no field to show under; the form must
 * still show it. Playwright takes the spec files in name order and the next one expects the seeded admin list, so the
 * test puts every place back.
 */
// oxlint-disable effecttsgo/async-function -- EX-0004: Playwright owns these Promise-returning browser callbacks.
import { expect, test } from "@playwright/test";
import { Array as Arr, Effect, Option } from "effect";

import {
  TEST_ADMIN,
  TEST_LEADER,
  openPage,
  sheetOf,
  signInAs,
  submitSheet,
} from "./support/panel.ts";
import {
  addAdminPlace,
  adminGrantRows,
  deleteAdminPlace,
  endAdminPlacesAt,
  endAdminPlacesSoon,
  runDatabase,
} from "./support/probes.ts";

const LAST_PLACE_REFUSED =
  "Den siste administratorplassen som varer etter dette semesteret kan ikke fjernes.";

test("issue 26: refusing to remove the last lasting admin place says why, and changes nothing", async ({
  page,
  context,
}) => {
  const seeded = await runDatabase(adminGrantRows);
  const own = Arr.findFirst(seeded, (place) => place.person === TEST_ADMIN);
  expect(Option.isSome(own)).toBe(true);

  // The signed-in admin's own place ends within the hour, so the leader's place is the only one that lasts.
  await runDatabase(endAdminPlacesSoon(TEST_ADMIN));

  const lasting = await runDatabase(
    addAdminPlace(TEST_LEADER, TEST_ADMIN, "2099-12-31T23:59:59Z")
  );

  try {
    const before = await runDatabase(adminGrantRows);

    await signInAs(context, TEST_ADMIN);
    await openPage(page, "/kontrollpanel/administratorer");
    await page
      .getByRole("button", { name: `Fjern plassen til ${TEST_LEADER}` })
      .click();
    expect(await submitSheet(page, "Fjern")).toBe(400);

    await expect(sheetOf(page).getByRole("alert")).toHaveText(
      LAST_PLACE_REFUSED
    );
    await expect(sheetOf(page)).toBeVisible();
    expect(await runDatabase(adminGrantRows)).toStrictEqual(before);
  } finally {
    await runDatabase(
      deleteAdminPlace(lasting).pipe(
        Effect.andThen(
          endAdminPlacesAt(TEST_ADMIN, Option.getOrThrow(own).until)
        )
      )
    );
  }
});
