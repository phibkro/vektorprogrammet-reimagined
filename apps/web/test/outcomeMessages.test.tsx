// @vitest-environment happy-dom
/**
 * Issue 26 on a rendered form: where a validation issue shows follows the `Field`s on screen now, and a
 * message under a field is tied to its control for assistive technology.
 */
import { assert, describe, it } from "@effect/vitest";
import { ValidationFailed } from "@vektorprogrammet/domain";
import { Array as Arr, Option, String as Str } from "effect";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { Field, OutcomeMessages } from "../src/components/forms";
import type { Outcome } from "../src/lib/outcome";
import { failureOf } from "../src/server/errors";

const REFUSAL = "Plassen kan ikke fjernes.";
const DATE_REFUSAL = "Ugyldig dato.";

const refused = (...issues: ValidationFailed["issues"]): Outcome<unknown> =>
  failureOf(new ValidationFailed({ issues }));

// React only runs effects inside `act` once the environment says so.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Renders `tree` into a detached element; `update` re-renders it, as a state change in a page would. */
const mount = (tree: ReactNode) => {
  const container = document.createElement("div");
  const root = createRoot(container);

  act(() => {
    root.render(tree);
  });

  return {
    alerts: () =>
      Arr.map(
        Arr.fromIterable(container.querySelectorAll("[role='alert']")),
        (element) => element.textContent
      ),
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
    update: (next: ReactNode) => {
      act(() => {
        root.render(next);
      });
    },
  };
};

const formOf = (
  outcome: Outcome<unknown>,
  ...names: readonly string[]
): ReactNode => (
  <OutcomeMessages outcome={outcome}>
    {Arr.map(names, (name, index) => (
      // A name may repeat: two fields on one path.
      <Field key={`${name}-${index}`} label={name} name={name}>
        <input name={name} />
      </Field>
    ))}
    <input name="id" type="hidden" value="7" />
  </OutcomeMessages>
);

describe("OutcomeMessages (issue 26)", () => {
  it("shows an issue on a hidden input in the alert, because no Field is rendered for it", () => {
    const page = mount(
      formOf(refused({ message: REFUSAL, path: ["id"] }), "until")
    );

    assert.deepStrictEqual(page.alerts(), [REFUSAL]);
    page.unmount();
  });

  it("shows an issue under its Field once, and not in the alert", () => {
    const page = mount(
      formOf(refused({ message: DATE_REFUSAL, path: ["until"] }), "until")
    );

    assert.deepStrictEqual(page.alerts(), []);
    assert.strictEqual(
      Str.split(page.container.textContent ?? "", DATE_REFUSAL).length,
      2
    );
    page.unmount();
  });

  it("follows the Fields on screen when they change while the outcome stays", () => {
    const outcome = refused({ message: DATE_REFUSAL, path: ["until"] });
    const page = mount(formOf(outcome, "until"));

    assert.deepStrictEqual(page.alerts(), []);

    // The Field the issue named leaves the page: its message has no place left, so the form says it.
    page.update(formOf(outcome));
    assert.deepStrictEqual(page.alerts(), [DATE_REFUSAL]);

    // It comes back, and the message returns under it.
    page.update(formOf(outcome, "until"));
    assert.deepStrictEqual(page.alerts(), []);

    // A second Field of the same name leaving does not take the place away from the first.
    page.update(formOf(outcome, "until", "until"));
    page.update(formOf(outcome, "until"));
    assert.deepStrictEqual(page.alerts(), []);
    page.unmount();
  });

  it("ties the message under a Field to its control: an id, aria-describedby and aria-invalid", () => {
    const page = mount(
      <OutcomeMessages
        outcome={refused({ message: DATE_REFUSAL, path: ["until"] })}
      >
        <Field label="Til" name="until">
          <input aria-describedby="hint" name="until" />
        </Field>
        <Field label="Person" name="personId">
          <input name="personId" />
        </Field>
      </OutcomeMessages>
    );

    const [date, person] = Arr.fromIterable(
      page.container.querySelectorAll("input")
    );

    const describedBy = Option.fromNullishOr(
      date?.getAttribute("aria-describedby")
    ).pipe(
      Option.map(Str.split(" ")),
      Option.getOrElse((): readonly string[] => [])
    );

    const message = page.container.querySelector(`[id='${describedBy[1]}']`);

    assert.strictEqual(date?.getAttribute("aria-invalid"), "true");
    assert.strictEqual(describedBy[0], "hint");
    assert.strictEqual(message?.textContent, DATE_REFUSAL);
    assert.isNull(person?.getAttribute("aria-invalid"));
    assert.isNull(person?.getAttribute("aria-describedby"));
    page.unmount();
  });
});
