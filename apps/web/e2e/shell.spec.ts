/**
 * Spec 0004, the control panel as a dashboard, in a browser: falsifiers 1 to 5, per actor (the administrator,
 * a team leader of department 1, an anonymous visitor), against `vp dev` and the same migrated database as
 * `journey.spec.ts`. Falsifier 3 (a forged request for a capability the page hides still gets 403) is also that
 * file's last test, the one of spec 0001. Playwright takes the spec files in name order, so this one runs after
 * the journey and may change what the journey leaves behind. Screenshots go to the directory in
 * `E2E_SCREENSHOT_DIRECTORY`, when set.
 */
import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { LOCAL_PEOPLE } from "@vektorprogrammet/domain";
import { Array as Arr, Record as Rec, String as Str } from "effect";

import { PANEL_SECTIONS } from "../src/lib/panelSections.ts";
import {
  TEST_ADMIN,
  TEST_LEADER,
  TEST_MEMBER,
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
import {
  auditEntryCount,
  departmentRow,
  departmentsInCity,
  runDatabase,
} from "./support/probes.ts";

/** Sections derived from the grants held by each seeded person. */
const SECTIONS_BY_ACTOR = {
  [TEST_ADMIN]: [
    "Oversikt",
    "Avdelinger",
    "Semestre",
    "Linjer",
    "Team",
    "Personer",
    "Administratorer",
    "Integrasjoner",
    "Arrangementer",
  ],
  [TEST_LEADER]: [
    "Oversikt",
    "Avdelinger",
    "Semestre",
    "Linjer",
    "Team",
    "Personer",
    "Arrangementer",
  ],
} as const;

type Staff = Extract<keyof typeof SECTIONS_BY_ACTOR, string>;

const STAFF: readonly Staff[] = [TEST_ADMIN, TEST_LEADER];

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
  { control: "Ny avdeling", path: DEPARTMENTS, shownTo: [TEST_ADMIN] },
  {
    control: "Rediger Avdeling Alfa",
    path: DEPARTMENTS,
    shownTo: [TEST_ADMIN, TEST_LEADER],
  },
  {
    control: "Rediger Avdeling Beta",
    path: DEPARTMENTS,
    shownTo: [TEST_ADMIN],
  },
  { control: "Vis Avdeling Beta", path: DEPARTMENTS, shownTo: [TEST_LEADER] },
  {
    control: "Ny linje",
    path: "/kontrollpanel/linjer",
    shownTo: [TEST_ADMIN, TEST_LEADER],
  },
  {
    control: "Gi nytt navn til Fag Alfa",
    path: "/kontrollpanel/linjer",
    shownTo: [TEST_ADMIN, TEST_LEADER],
  },
  {
    control: "Nytt arrangement",
    path: "/kontrollpanel/arrangementer",
    shownTo: [TEST_ADMIN, TEST_LEADER],
  },
  {
    control: "Nytt team",
    path: "/kontrollpanel/team",
    shownTo: [TEST_ADMIN, TEST_LEADER],
  },
  {
    control: "Registrer person",
    path: "/kontrollpanel/personer",
    shownTo: [TEST_ADMIN, TEST_LEADER],
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
  for (const path of [
    "/",
    "/om-oss",
    "/assistenter",
    "/team",
    "/foreldre",
    "/skoler",
    "/nyheter",
    "/kontakt",
  ]) {
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

      if (path === DEPARTMENTS) {
        await screenshot(page, `departments-${actor}`);
      }
    });
  }
}

/** Headers the transport owns: a replay lets its own client set them. */
const TRANSPORT_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
]);

test("falsifier 3: a forged request for a capability the page does not offer gets 403 and changes nothing", async ({
  page,
  context,
}) => {
  await signInAs(context, TEST_LEADER);
  await openPage(page, DEPARTMENTS);

  // One real save of the leader's own department, to learn where the department form sends its data.
  const sent = page.waitForRequest(
    (request) =>
      Str.includes("/_serverFn/")(request.url()) && request.method() === "POST"
  );

  await page.getByRole("button", { name: "Rediger Avdeling Alfa" }).click();
  expect(await submitSheet(page, "Lagre")).toBe(200);

  const real = await sent;

  const headers = Rec.filter(
    await real.allHeaders(),
    (_value, name) => !TRANSPORT_HEADERS.has(name)
  );

  const betaBefore = await runDatabase(departmentRow(2));
  const audited = await runDatabase(auditEntryCount);

  // The same session sends, by hand, what the page has no button for: another department's edit, and a new
  // department. The server decides, so both are refused.
  const forged: readonly Readonly<Record<string, string>>[] = [
    {
      active: "on",
      city: "Betaby",
      email: "kontakt@beta.example",
      id: "2",
      name: "Kapret",
      shortName: "KAP",
    },
    {
      active: "on",
      city: "Snikby",
      email: "sni@example.org",
      name: "Snikopprettet",
      shortName: "SNI",
    },
  ];

  for (const fields of forged) {
    const response = await context.request.post(real.url(), {
      headers,
      multipart: fields,
    });

    // The domain's refusal, with its own message: not a rejected transport (a CSRF refusal is a 403 too).
    expect(response.status()).toBe(403);
    expect(await response.text()).toContain("Du har ikke tilgang til dette.");
  }

  expect(await runDatabase(departmentRow(2))).toEqual(betaBefore);
  expect(await runDatabase(departmentsInCity("Snikby"))).toBe(0);
  expect(await runDatabase(auditEntryCount)).toBe(audited);

  // Control: the same request from an administrator is accepted, so the refusals above were about the actor.
  await signInAs(context, TEST_ADMIN);

  const accepted = await context.request.post(real.url(), {
    headers,
    multipart: {
      active: "on",
      city: "Betaby",
      email: "kontakt@beta.example",
      id: "2",
      name: "Avdeling Beta",
      shortName: "BETA",
    },
  });

  expect(accepted.status()).toBe(200);
});

/** Every local person and a visitor who is not signed in. */
const EVERY_ACTOR = [...LOCAL_PEOPLE, "anonymous"] as const;

test("issue 15: a control-panel page answers 2xx exactly when the sidebar shows its section, and 403 otherwise, for every actor", async ({
  page,
  context,
}) => {
  await signInAs(context, TEST_ADMIN);
  await openPage(page, "/kontrollpanel/team");

  const teamPath = await page
    .locator("a[href^='/kontrollpanel/team/']")
    .first()
    .getAttribute("href");

  // Every section's page, and one team's page (a page below the Team section).
  const routes = [
    ...Arr.map(PANEL_SECTIONS, (section) => ({
      label: section.label,
      path: section.to,
    })),
    { label: "Team", path: teamPath ?? "" },
  ];

  const statuses: number[] = [];

  for (const actor of EVERY_ACTOR) {
    await signInAs(context, actor);
    await openPage(page, "/kontrollpanel");

    const shown = new Set(
      Arr.map(
        await sidebarOf(page).getByRole("link").allTextContents(),
        (label) => Str.trim(label)
      )
    );

    for (const route of routes) {
      const response = await context.request.get(route.path);
      const status = response.status();

      statuses.push(status);
      expect(status, `${actor}: ${route.path}`).toBe(
        shown.has(route.label) ? 200 : 403
      );
    }
  }

  // Not vacuous: some pages were served and some refused.
  expect(statuses).toContain(200);
  expect(statuses).toContain(403);
});

test("issue 15: a member without viewPeople gets 403 for the people page and for its server function, with no row in the answer; a leader is served", async ({
  page,
  context,
}) => {
  await signInAs(context, TEST_LEADER);
  await openPage(page, "/kontrollpanel");

  // Learn the people read's address from the click that loads the page's data.
  const sent = page.waitForRequest(
    (request) =>
      Str.includes("/_serverFn/")(request.url()) && request.method() === "GET"
  );

  await sidebarOf(page).getByRole("link", { name: "Personer" }).click();

  const real = await sent;

  const headers = Rec.filter(
    await real.allHeaders(),
    (_value, name) => !TRANSPORT_HEADERS.has(name)
  );

  const served = await context.request.get(real.url(), { headers });

  expect(served.status()).toBe(200);
  expect(await served.text()).toContain(TEST_MEMBER);

  // Control above: the same request answers the leader. The member and the visitor hold no `viewPeople`.
  for (const actor of [TEST_MEMBER, "anonymous"]) {
    await signInAs(context, actor);

    const refused = await context.request.get(real.url(), { headers });

    expect(refused.status(), `${actor}: the people read`).toBe(403);

    const body = await refused.text();

    expect(body).toContain("Du har ikke tilgang til dette.");
    expect(body).not.toContain(TEST_MEMBER);

    const refusedPage = await page.goto("/kontrollpanel/personer");

    expect(refusedPage?.status(), `${actor}: the people page`).toBe(403);
  }
});

test("falsifier 4: create and edit happen in a right-hand Sheet; a saved edit shows in the table without a page reload; Escape and Cancel close it and return focus to the opener", async ({
  page,
  context,
}) => {
  await signInAs(context, TEST_ADMIN);
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
    By: "Gammaby",
    "E-post": "kontakt@gamma.example",
    Kortnavn: "GAMMA",
    Navn: "Avdeling Gamma",
  });
  expect(await submitSheet(page, "Opprett")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();
  await expect(page.getByRole("row", { name: "Avdeling Gamma" })).toBeVisible();
  await expectPageNotReloaded(page);
  await expect(create).toBeFocused();

  // Editing it: the saved edit is in the table, still without a reload, and focus is back on the row's button.
  await page.getByRole("button", { name: "Rediger Avdeling Gamma" }).click();
  await fillSheet(page, { Navn: "Avdeling Delta" });
  expect(await submitSheet(page, "Lagre")).toBe(200);
  await expect(sheetOf(page)).toBeHidden();

  const edited = page.getByRole("row", { name: "Avdeling Delta" });

  await expect(edited).toBeVisible();
  await expect(page.getByRole("row", { name: "Avdeling Gamma" })).toHaveCount(
    0
  );
  await expectPageNotReloaded(page);
  await expect(edited.getByRole("button")).toBeFocused();
});

test("falsifier 5 (1280 px): the sidebar collapses to icons and back", async ({
  page,
  context,
}) => {
  await signInAs(context, TEST_ADMIN);
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
  await expect(page.locator("[data-slot='tooltip-content']")).toHaveText(
    "Avdelinger"
  );
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
  await signInAs(context, TEST_ADMIN);
  await page.setViewportSize({ height: 844, width: 390 });
  await openPage(page, DEPARTMENTS);

  // Closed: no sidebar in the page, only the toggle in the header.
  await expect(sidebarOf(page)).toHaveCount(0);
  await screenshot(page, "shell-390-closed");

  await sidebarToggleOf(page).click();
  await expect(sheetOf(page)).toBeVisible();
  await expect(sidebarOf(page).getByRole("link")).toHaveText(
    SECTIONS_BY_ACTOR[TEST_ADMIN]
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
