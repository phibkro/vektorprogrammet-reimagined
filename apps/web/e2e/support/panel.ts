/**
 * Helpers the specs share: the local test actor, the dialog every control-panel form opens in, the server
 * function call a click makes, and the semester labels a page lists. Locators go by role and visible label,
 * as a person reads the page.
 */
import type { BrowserContext, Locator, Page, Response } from "@playwright/test";
import { Array as Arr, DateTime, Record as Rec } from "effect";

/** The cookie `apps/web/src/server/actor.ts` reads in a `local` deployment (`TEST_ACTOR_COOKIE`). */
const TEST_ACTOR_COOKIE = "vp-test-actor";

export type Actor = "admin" | "teamLeader";

/** Selects the local test actor for every page of `localhost` the context opens. */
export const signInAs = async (context: BrowserContext, actor: Actor) => {
  await context.addCookies([
    { domain: "localhost", name: TEST_ACTOR_COOKIE, path: "/", value: actor },
  ]);
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

export const dialogOf = (page: Page) => page.getByRole("dialog");

/**
 * Fills the open dialog's fields by their labels, in the order given (the whole label, so "Navn" never
 * matches "Kortnavn"). One after another: each `fill` moves the focus, so concurrent fills type into the
 * wrong fields.
 */
export const fillDialog = async (
  page: Page,
  fields: Readonly<Record<string, string>>
) => {
  for (const [label, value] of Rec.toEntries(fields)) {
    await dialogOf(page).getByLabel(label, { exact: true }).fill(value);
  }
};

/**
 * Rewrites a hidden field of the open dialog's form before it is submitted, as a person with the browser's
 * developer tools would: the page offers no way to send this request, the server must refuse it anyway.
 */
export const tamperWith = async (
  page: Page,
  field: string,
  forgedValue: string
) => {
  await dialogOf(page)
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
export const statusOfClick = async (
  page: Page,
  button: Locator
): Promise<number> => {
  const [response] = await Promise.all([
    page.waitForResponse(isServerFunctionPost),
    button.click(),
  ]);

  return response.status();
};

/** Presses a button of the open dialog and returns the status of the server function call it made. */
export const submitDialog = async (
  page: Page,
  buttonName: string
): Promise<number> =>
  await statusOfClick(
    page,
    dialogOf(page).getByRole("button", { name: buttonName })
  );

/** The visible text of an element, `""` when it has none. */
export const textOf = async (locator: Locator): Promise<string> => {
  const text = await locator.textContent();

  return text ?? "";
};

/** The item a shadcn select shows as chosen. The trigger's own text also holds its chevron. */
export const chosenOf = async (select: Locator): Promise<string> =>
  await textOf(select.locator("[data-slot='select-value']"));

/** The year after the current Oslo year: the last one the semester form offers (RULE-190). */
export const nextOsloYear = (): number =>
  DateTime.toParts(
    DateTime.setZone(
      DateTime.nowUnsafe(),
      DateTime.zoneMakeNamedUnsafe("Europe/Oslo")
    )
  ).year + 1;

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
