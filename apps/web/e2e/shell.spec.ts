/**
 * Spec 0004, the control panel as a dashboard, in a browser: falsifiers 1, 2, 4 and 5, per actor (the
 * administrator, a team leader of department 1, an anonymous visitor), against `vp dev` and the same migrated
 * database as `journey.spec.ts`. Falsifier 3 (a forged request for a hidden capability still gets 403) is that
 * file's last test. Playwright takes the spec files in name order, so this one runs after the journey and may
 * change what the journey leaves behind. Screenshots go to the directory in `E2E_SCREENSHOT_DIRECTORY`, when set.
 */
import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { Array as Arr } from "effect";

import {
  expectPageNotReloaded,
  fillSheet,
  markPage,
  openPage,
  screenshot,
  sheetOf,
  sidebarOf,
  sidebarToggleOf,
  signInAs,
  submitSheet,
} from "./support/panel.ts";

/** The sections the sidebar lists, by actor: what each one's capabilities allow (domain `authorize`). */
const SECTIONS_BY_ACTOR = {
  admin: [
    "Oversikt",
    "Avdelinger",
    "Semestre",
    "Linjer",
    "Statisk innhold",
    "Artikler",
    "Sponsorer",
    "Arrangementer",
  ],
  teamLeader: [
    "Oversikt",
    "Avdelinger",
    "Semestre",
    "Linjer",
    "Artikler",
    "Sponsorer",
    "Arrangementer",
  ],
} as const;

type Staff = keyof typeof SECTIONS_BY_ACTOR;

const STAFF: readonly Staff[] = ["admin", "teamLeader"];

/** The page title of a section: the overview is called the control panel. */
const titleOf = (section: string) =>
  section === "Oversikt" ? "Kontrollpanel" : section;

const DEPARTMENTS = "/kontrollpanel/avdelinger";

/** The sidebar entry that marks the page the address names. */
const currentEntryOf = (sidebar: Locator) =>
  sidebar.locator("a[aria-current='page']");

/**
 * Every control a capability gates, on its page, and who sees it. A control the actor lacks is not rendered at
 * all: not hidden, not disabled.
 */
const GATED_CONTROLS: readonly {
  readonly path: string;
  readonly control: string;
  readonly shownTo: readonly Staff[];
}[] = [
  { control: "Ny avdeling", path: DEPARTMENTS, shownTo: ["admin"] },
  {
    control: "Rediger Avdeling Alfa",
    path: DEPARTMENTS,
    shownTo: ["admin", "teamLeader"],
  },
  { control: "Rediger Avdeling Beta", path: DEPARTMENTS, shownTo: ["admin"] },
  { control: "Vis Avdeling Beta", path: DEPARTMENTS, shownTo: ["teamLeader"] },
  {
    control: "Ny linje",
    path: "/kontrollpanel/linjer",
    shownTo: ["admin", "teamLeader"],
  },
  {
    control: "Gi nytt navn til Fag Alfa",
    path: "/kontrollpanel/linjer",
    shownTo: ["admin", "teamLeader"],
  },
  {
    control: "Rediger about-header",
    path: "/kontrollpanel/statisk-innhold",
    shownTo: ["admin"],
  },
  {
    control: "Ny artikkel",
    path: "/kontrollpanel/artikler",
    shownTo: ["admin", "teamLeader"],
  },
  {
    control: "Publiser etter id",
    path: "/kontrollpanel/artikler",
    shownTo: ["admin", "teamLeader"],
  },
  {
    control: "Ny sponsor",
    path: "/kontrollpanel/sponsorer",
    shownTo: ["admin", "teamLeader"],
  },
  {
    control: "Nytt arrangement",
    path: "/kontrollpanel/arrangementer",
    shownTo: ["admin", "teamLeader"],
  },
];

const GATED_PATHS = Arr.dedupe(Arr.map(GATED_CONTROLS, (gated) => gated.path));

for (const actor of STAFF) {
  test(`falsifier 1 (${actor}): the sidebar lists exactly the sections the actor may use, and each one opens its page`, async ({
    page,
    context,
  }) => {
    await signInAs(context, actor);
    await openPage(page, "/kontrollpanel");

    const sections = SECTIONS_BY_ACTOR[actor];
    const sidebar = sidebarOf(page);

    await expect(sidebar.getByRole("link")).toHaveText(sections);
    await expect(currentEntryOf(sidebar)).toHaveText("Oversikt");

    for (const section of sections) {
      await sidebar.getByRole("link", { name: section }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: titleOf(section) })
      ).toBeVisible();
      await expect(currentEntryOf(sidebar)).toHaveText(section);
      await expect(
        page.getByRole("navigation", { name: "Brødsmulesti" })
      ).toContainText(titleOf(section));
    }
  });
}

test("falsifier 1 (anonymous): no control-panel navigation or link anywhere, and /kontrollpanel renders the not-signed-in page", async ({
  page,
  context,
}) => {
  await signInAs(context, "anonymous");

  for (const path of ["/kontrollpanel", DEPARTMENTS]) {
    await openPage(page, path);
    await expect(
      page.getByRole("heading", { level: 1, name: "Ikke innlogget" })
    ).toBeVisible();
    await expect(sidebarOf(page)).toHaveCount(0);
    await expect(page.locator("[data-slot='sidebar-wrapper']")).toHaveCount(0);
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.locator("a[href^='/kontrollpanel']")).toHaveCount(0);
  }

  // The public site has no way in: not in its header, its footer or its pages.
  for (const path of ["/", "/omvektor", "/foreldre", "/nyheter", "/kontakt"]) {
    await openPage(page, path);
    await expect(page.locator("a[href^='/kontrollpanel']")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /kontrollpanel/iu })
    ).toHaveCount(0);
  }
});

for (const actor of STAFF) {
  for (const path of GATED_PATHS) {
    test(`falsifier 2 (${actor}): ${path} renders only the controls the actor may use`, async ({
      page,
      context,
    }) => {
      await signInAs(context, actor);
      await openPage(page, path);

      for (const gated of Arr.filter(
        GATED_CONTROLS,
        (each) => each.path === path
      )) {
        await expect(
          page.getByRole("button", { includeHidden: true, name: gated.control })
        ).toHaveCount(gated.shownTo.includes(actor) ? 1 : 0);
      }
    });
  }
}

test("falsifier 4: create and edit happen in a right-hand Sheet; a saved edit shows in the table without a page reload; Escape and Cancel close it and return focus to the opener", async ({
  page,
  context,
}) => {
  await signInAs(context, "admin");
  await openPage(page, DEPARTMENTS);
  await markPage(page);

  const create = page.getByRole("button", { name: "Ny avdeling" });
  const viewportWidth = page.viewportSize()?.width ?? 0;

  // The form slides in from the right edge, over the page.
  await create.click();
  await expect(sheetOf(page)).toHaveAttribute("data-side", "right");
  await expect
    .poll(async () => {
      const box = await sheetOf(page).boundingBox();

      return box === null ? -1 : Math.round(box.x + box.width);
    })
    .toBe(viewportWidth);

  // Escape closes it and focus returns to the control that opened it.
  await page.keyboard.press("Escape");
  await expect(sheetOf(page)).toBeHidden();
  await expect(create).toBeFocused();

  // So does Cancel.
  await create.click();
  await sheetOf(page).getByRole("button", { name: "Avbryt" }).click();
  await expect(sheetOf(page)).toBeHidden();
  await expect(create).toBeFocused();

  // Saving a new department closes the Sheet; the table shows it, and the page was not reloaded.
  await create.click();
  await fillSheet(page, {
    By: "Sheetby",
    "E-post": "sheet@example.org",
    Kortnavn: "SHT",
    Navn: "Sheet-avdeling",
  });
  expect(await submitSheet(page, "Opprett")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  await expect(page.getByRole("row", { name: "Sheet-avdeling" })).toBeVisible();
  await expectPageNotReloaded(page);
  await expect(create).toBeFocused();

  // Editing it: the saved edit is in the table, still without a reload, and focus is back on the row's button.
  await page.getByRole("button", { name: "Rediger Sheet-avdeling" }).click();
  await fillSheet(page, { Navn: "Sheet-avdeling (endret)" });
  expect(await submitSheet(page, "Lagre")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();

  const edited = page.getByRole("row", { name: "Sheet-avdeling (endret)" });

  await expect(edited).toBeVisible();
  await expect(
    page.getByRole("row", { name: /^Sheet-avdeling Sheet/u })
  ).toHaveCount(0);
  await expectPageNotReloaded(page);
  await expect(edited.getByRole("button")).toBeFocused();
});

test("falsifier 5 (1280 px): the sidebar collapses to icons and back", async ({
  page,
  context,
}) => {
  await signInAs(context, "admin");
  await page.setViewportSize({ height: 800, width: 1280 });
  await openPage(page, DEPARTMENTS);

  const sidebar = page.locator("[data-slot='sidebar']");
  const container = page.locator("[data-slot='sidebar-container']");

  const widthOfSidebar = async () => {
    const box = await container.boundingBox();

    return box === null ? 0 : box.width;
  };

  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect.poll(widthOfSidebar).toBeGreaterThan(200);
  await expect(currentEntryOf(sidebarOf(page))).toHaveText("Avdelinger");
  await screenshot(page, "shell-1280-expanded");

  await sidebarToggleOf(page).click();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect(sidebar).toHaveAttribute("data-collapsible", "icon");
  await expect.poll(widthOfSidebar).toBeLessThan(100);

  // Icons only, and each entry still names itself, by tooltip and for a screen reader.
  await sidebarOf(page).getByRole("link", { name: "Avdelinger" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Avdelinger");
  await page.mouse.move(700, 500);
  await screenshot(page, "shell-1280-collapsed");

  await sidebarToggleOf(page).click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect.poll(widthOfSidebar).toBeGreaterThan(200);

  // A Sheet in front of the page, for the record.
  await page.getByRole("button", { name: "Rediger Avdeling Alfa" }).click();
  await expect(sheetOf(page)).toBeVisible();
  await page.waitForTimeout(400);
  await screenshot(page, "shell-1280-sheet");
});

test("falsifier 5 (390 px): the sidebar opens as an off-canvas panel", async ({
  page,
  context,
}) => {
  await signInAs(context, "admin");
  await page.setViewportSize({ height: 844, width: 390 });
  await openPage(page, DEPARTMENTS);

  // Closed: no sidebar in the page, only the toggle in the header.
  await expect(sidebarOf(page)).toHaveCount(0);
  await screenshot(page, "shell-390-closed");

  await sidebarToggleOf(page).click();
  await expect(sheetOf(page)).toBeVisible();
  await expect(sidebarOf(page).getByRole("link")).toHaveText(
    SECTIONS_BY_ACTOR.admin
  );
  await page.waitForTimeout(400);
  await screenshot(page, "shell-390-offcanvas");

  // Escape closes it and focus returns to the toggle.
  await page.keyboard.press("Escape");
  await expect(sheetOf(page)).toBeHidden();
  await expect(sidebarToggleOf(page)).toBeFocused();

  // Choosing a section opens it and closes the panel.
  await sidebarToggleOf(page).click();
  await sidebarOf(page).getByRole("link", { name: "Linjer" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Linjer" })
  ).toBeVisible();
  await expect(sheetOf(page)).toBeHidden();
});
