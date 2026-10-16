/**
 * Helpers the specs share: the local test actor, the Sheet every control-panel form opens in, the server
 * function call a click makes, the sidebar, and the semester labels a page lists. Locators go by role and
 * visible label, as a person reads the page.
 */
import { expect } from "@playwright/test";
import type { BrowserContext, Locator, Page, Response } from "@playwright/test";
import { Array as Arr, Config, Effect, Option, Record as Rec } from "effect";

/** The cookie `apps/web/src/server/actor.ts` reads in a `local` deployment (`TEST_ACTOR_COOKIE`). */
const TEST_ACTOR_COOKIE = "vp-test-actor";

export type Actor = "admin" | "teamLeader" | "anonymous";

/** Selects the local test actor for every page of `localhost` the context opens. */
export const signInAs = async (context: BrowserContext, actor: Actor) => {
  await context.addCookies([
    { domain: "localhost", name: TEST_ACTOR_COOKIE, path: "/", value: actor },
  ]);
};

const screenshotDirectory = Effect.runSync(
  Config.option(Config.String("E2E_SCREENSHOT_DIRECTORY"))
);

/** Saves the viewport as `<name>.png` in `E2E_SCREENSHOT_DIRECTORY`; a run without that variable takes none. */
export const screenshot = async (page: Page, name: string) => {
  if (Option.isSome(screenshotDirectory)) {
    await page.screenshot({ path: `${screenshotDirectory.value}/${name}.png` });
  }
};

/**
 * Runs in the page, where Effect is not loaded, so it is a source string rather than a function. React marks
 * every DOM node it has hydrated with a `__reactFiber$…` key; the page is interactive when every control in
 * `main` has one.
 */
const INTERACTIVE_CONTENT_IS_HYDRATED =
  "[...document.querySelectorAll('main :is(a, button, form, input, select, textarea)')].every((element) => Object.keys(element).some((key) => key.startsWith('__reactFiber$')))";

/**
 * Opens a page and waits until its controls are hydrated. The server renders every control the specs use,
 * but until React has hydrated it a click does nothing, and the submit button of a form submits it natively.
 * In development the route components arrive late, so the specs never `goto` directly.
 */
export const openPage = async (page: Page, path: string) => {
  await page.goto(path);
  await page.waitForFunction(INTERACTIVE_CONTENT_IS_HYDRATED);
};

/** The Sheet that is open (a form, a record's details, or the phone's sidebar). */
export const sheetOf = (page: Page) => page.getByRole("dialog");

/** The sidebar's list of sections (a landmark of the sidebar, not of the page header or footer). */
export const sidebarOf = (page: Page) =>
  page.getByRole("navigation", { name: "Kontrollpanel" });

/** The button that expands or collapses the sidebar (on a phone it opens the off-canvas panel). */
export const sidebarToggleOf = (page: Page) =>
  page.getByRole("button", { name: "Vis eller skjul sidemenyen" });

/**
 * Fills the open Sheet's fields by their labels, in the order given (the whole label, so "Navn" never
 * matches "Kortnavn"). One after another: each `fill` moves the focus, so concurrent fills type into the
 * wrong fields.
 */
export const fillSheet = async (
  page: Page,
  fields: Readonly<Record<string, string>>
) => {
  for (const [label, value] of Rec.toEntries(fields)) {
    await sheetOf(page).getByLabel(label, { exact: true }).fill(value);
  }
};

/**
 * Rewrites a hidden field of the open Sheet's form before it is submitted, as a person with the browser's
 * developer tools would: the page offers no way to send this request, the server must refuse it anyway.
 */
export const tamperWith = async (
  page: Page,
  field: string,
  forgedValue: string
) => {
  await sheetOf(page)
    .locator(`input[name="${field}"]`)
    .evaluate((input: HTMLInputElement, forged: string) => {
      input.value = forged;
    }, forgedValue);
};

const isServerFunctionPost = (response: Response): boolean =>
  response.url().includes("/_serverFn/") &&
  response.request().method() === "POST";

/**
 * Clicks `button` and returns the HTTP status of the server function that click called: the refusals in the
 * specs are asserted on the status the server sent, not only on the message the page shows.
 */
const statusOfClick = async (page: Page, button: Locator): Promise<number> => {
  const [response] = await Promise.all([
    page.waitForResponse(isServerFunctionPost),
    button.click(),
  ]);

  return response.status();
};

/** Presses a button of the open Sheet and returns the status of the server function call it made. */
export const submitSheet = async (
  page: Page,
  buttonName: string
): Promise<number> =>
  await statusOfClick(
    page,
    sheetOf(page).getByRole("button", { name: buttonName })
  );

/**
 * Marks the document so a later check can tell a full page reload from a client-side update: a reload builds
 * a new `body`, and React never writes this attribute back.
 */
export const markPage = async (page: Page) => {
  await page.evaluate(() => {
    document.body.dataset.marker = "kept";
  });
};

/** The page is still the one `markPage` marked: nothing reloaded it. */
export const expectPageNotReloaded = async (page: Page) => {
  await expect(page.locator("body")).toHaveAttribute("data-marker", "kept");
};

/** The visible text of an element, `""` when it has none. */
export const textOf = async (locator: Locator): Promise<string> => {
  const text = await locator.textContent();

  return text ?? "";
};

/**
 * The semester right after a label (RULE-050): `"Vår 2026"` → `"Høst 2026"`, `"Høst 2026"` → `"Vår 2027"`. Written
 * out on labels here, independent of the domain function the job uses, so the spec checks the job's answer.
 */
export const successorOf = (label: string): string => {
  const [term, year] = label.split(" ");

  return term === "Vår" ? `Høst ${year}` : `Vår ${Number(year) + 1}`;
};

/** `"Høst 2026"` → a sort key where a later semester is larger (Vår before Høst within a year). */
export const semesterKey = (label: string): number => {
  const [term, year] = label.split(" ");

  return Number(year) * 2 + (term === "Høst" ? 1 : 0);
};

/** The semester labels ("Vår 2026"), in page order, that the table rows of the page start with. */
export const semesterLabelsOf = async (
  page: Page
): Promise<readonly string[]> => {
  const rows = await page.getByRole("row").allInnerTexts();

  return Arr.flatMap(rows, (text) => {
    const label = /^(?<label>(?:Vår|Høst) \d{4})/u.exec(text)?.groups?.label;

    return label === undefined ? [] : [label];
  });
};

/** The semester the overview names as the current one. */
export const currentSemesterOnOverview = async (page: Page): Promise<string> =>
  await textOf(
    page
      .locator("[data-slot='card']")
      .filter({ hasText: "Nåværende semester" })
      .locator("[data-slot='card-title']")
  );
