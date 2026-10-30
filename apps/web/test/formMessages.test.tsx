// @vitest-environment happy-dom
/**
 * Spec 0010a F3, and issue 26 on a rendered form: a message is shown where its field is on screen now (and in the form's
 * one alert when no field is), the browser's own messages and the server's are the same words, and a form that the
 * schema refuses sends nothing.
 */
import { assert, describe, it } from "@effect/vitest";
import { ValidationFailed } from "@vektorprogrammet/domain";
import { Array as Arr, Schema } from "effect";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { CommandFormView } from "../src/components/form/commandForm";
import type { FieldComponent } from "../src/components/form/field";
import { Input } from "../src/components/ui/input";
import { Switch } from "../src/components/ui/switch";
import {
  Text,
  formSchema,
  isChecked,
  wholeNumber,
} from "../src/forms/formSchema";
import { success } from "../src/lib/outcome";
import type { Outcome } from "../src/lib/outcome";
import { failureOf } from "../src/server/errors";
import { typeInto } from "./support/typeInto";

const REFUSAL = "Plassen kan ikke fjernes.";
const DATE_REFUSAL = "Ugyldig dato.";
const REQUIRED = "Feltet kan ikke være tomt.";

const refused = (...issues: ValidationFailed["issues"]): Outcome<string> =>
  failureOf(new ValidationFailed({ issues }));

/** A form of three values: a hidden id, a switch, and `until`, which must not be blank. */
const UntilForm = formSchema(
  Schema.Struct({ active: Text, id: Text, until: Text }),
  Schema.Struct({
    active: Schema.Boolean,
    id: Schema.Int,
    until: Schema.String.check(Schema.isNonEmpty({ message: REQUIRED })),
  }),
  (text) => ({
    active: isChecked(text.active),
    id: wholeNumber(text.id),
    until: text.until ?? "",
  })
);

type UntilField = FieldComponent<typeof UntilForm.schema.Encoded>;

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

/** Renders `tree` into a detached element; `update` re-renders it, as a state change in a page would. */
const mount = (tree: ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  act(() => {
    root.render(tree);
  });

  const texts = (selector: string) =>
    Arr.map(
      Arr.fromIterable(container.querySelectorAll(selector)),
      (element) => element.textContent
    );

  return {
    alerts: () => texts("[role='alert']"),
    container,
    messages: () => texts("p.text-destructive"),
    submit: async () => {
      act(() => {
        container
          .querySelector("form")
          ?.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true })
          );
      });
      await settle();
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
    update: (next: ReactNode) => {
      act(() => {
        root.render(next);
      });
    },
  };
};

const fields =
  (...names: readonly ("id" | "until")[]) =>
  (Field: UntilField) =>
    Arr.map(names, (name, index) => (
      // A name may repeat: two fields on one path.
      <Field key={`${name}-${index}`} label={name} name={name}>
        <Input />
      </Field>
    ));

/** What the form holds when a test does not say: a hidden id and a date. */
const FILLED = { id: "7", until: "2030-01-01T00:00" };

const view = (
  run: (options: { data: FormData }) => Promise<Outcome<string>>,
  children: (Field: UntilField) => ReactNode,
  defaults: typeof UntilForm.schema.Encoded = FILLED
) => (
  <CommandFormView
    defaults={defaults}
    reload={() => Promise.resolve()}
    run={run}
    schema={UntilForm.schema}
    submitLabel="Send"
  >
    {children}
  </CommandFormView>
);

/** What the server function answers: a Promise of the outcome. */
const answered = (outcome: Outcome<string>): Promise<Outcome<string>> =>
  Promise.resolve(outcome);

const answers = (outcome: Outcome<string>) => () => answered(outcome);

describe("a form's messages (issue 26)", () => {
  it("shows an issue on a hidden value in the alert, because no Field is rendered for it", async () => {
    const page = mount(
      view(
        answers(refused({ message: REFUSAL, path: ["id"] })),
        fields("until")
      )
    );

    await page.submit();
    assert.deepStrictEqual(page.alerts(), [REFUSAL]);
    page.unmount();
  });

  it("shows an issue under its Field once, and not in the alert", async () => {
    const page = mount(
      view(
        answers(refused({ message: DATE_REFUSAL, path: ["until"] })),
        fields("until")
      )
    );

    await page.submit();
    assert.deepStrictEqual(page.alerts(), []);
    assert.deepStrictEqual(page.messages(), [DATE_REFUSAL]);
    page.unmount();
  });

  it("follows the Fields on screen when they change while the outcome stays", async () => {
    const run = answers(refused({ message: DATE_REFUSAL, path: ["until"] }));
    const page = mount(view(run, fields("until")));

    await page.submit();
    assert.deepStrictEqual(page.alerts(), []);

    // The Field the issue named leaves the page: its message has no place left, so the form says it.
    page.update(view(run, fields()));
    assert.deepStrictEqual(page.alerts(), [DATE_REFUSAL]);

    // It comes back, and the message returns under it.
    page.update(view(run, fields("until")));
    assert.deepStrictEqual(page.alerts(), []);

    // A second Field of the same name leaving does not take the place away from the first.
    page.update(view(run, fields("until", "until")));
    page.update(view(run, fields("until")));
    assert.deepStrictEqual(page.alerts(), []);
    page.unmount();
  });

  it("ties the message under a Field to its control: an id, aria-describedby and aria-invalid", async () => {
    const page = mount(
      view(
        answers(refused({ message: DATE_REFUSAL, path: ["until"] })),
        (Field) => (
          <>
            <Field label="Til" name="until">
              <input aria-describedby="hint" />
            </Field>
            <Field label="Person" name="id">
              <input />
            </Field>
          </>
        )
      )
    );

    await page.submit();

    const [date, person] = Arr.fromIterable(
      page.container.querySelectorAll("input")
    );

    const describedBy =
      date?.getAttribute("aria-describedby")?.split(" ") ?? [];

    const message = page.container.querySelector(`[id='${describedBy[1]}']`);

    assert.strictEqual(date?.getAttribute("aria-invalid"), "true");
    assert.strictEqual(describedBy[0], "hint");
    assert.strictEqual(message?.textContent, DATE_REFUSAL);
    assert.isNull(person?.getAttribute("aria-invalid"));
    assert.isNull(person?.getAttribute("aria-describedby"));
    page.unmount();
  });

  it("says that something went wrong when the server function itself fails", async () => {
    const page = mount(
      view(() => Promise.reject(new Error("boom")), fields("until"))
    );

    await page.submit();
    assert.deepStrictEqual(page.alerts(), [
      "Noe gikk galt. Prøv igjen senere.",
    ]);
    page.unmount();
  });
});

describe("a form the schema refuses", () => {
  it("F3: sends nothing, and says what the schema says under the field", async () => {
    const sent: FormData[] = [];

    const page = mount(
      view(
        ({ data }) => {
          sent.push(data);

          return answered(success("Lagret."));
        },
        fields("until"),
        { id: "7", until: "" }
      )
    );

    await page.submit();
    assert.deepStrictEqual(sent.length, 0);
    assert.deepStrictEqual(page.messages(), [REQUIRED]);
    page.unmount();
  });

  it("issue 74: an earlier server message does not stay beside the schema's new one; without the refusal it stays", async () => {
    const page = mount(
      view(
        answers(refused({ message: DATE_REFUSAL, path: ["until"] })),
        fields("until")
      )
    );

    await page.submit();
    assert.deepStrictEqual(page.messages(), [DATE_REFUSAL]);

    // Control: another valid post keeps the server's answer (the server said it again).
    await page.submit();
    assert.deepStrictEqual(page.messages(), [DATE_REFUSAL]);

    const input = page.container.querySelector("input");
    assert.isNotNull(input);

    if (input !== null) {
      typeInto(input, "");
    }

    await page.submit();
    assert.deepStrictEqual(page.messages(), [REQUIRED]);
    page.unmount();
  });

  it("F3 control: a form the schema accepts sends its values as a FormData, once", async () => {
    const sent: FormData[] = [];

    const page = mount(
      view(({ data }) => {
        sent.push(data);

        return answered(success("Lagret."));
      }, fields("until"))
    );

    await page.submit();
    assert.deepStrictEqual(sent.length, 1);
    assert.strictEqual(sent[0]?.get("id"), "7");
    assert.strictEqual(sent[0]?.get("until"), "2030-01-01T00:00");
    assert.deepStrictEqual(page.messages(), []);
    page.unmount();
  });
});

const switchField = (Field: UntilField) => (
  <Field label="Aktiv" name="active">
    <Switch />
  </Field>
);

describe("a switch in a form", () => {
  it("F3: a switch that is off holds nothing, the form is valid, and nothing is posted for it", async () => {
    const sent: FormData[] = [];

    const page = mount(
      view(
        ({ data }) => {
          sent.push(data);

          return answered(success("Lagret."));
        },
        switchField,
        { ...FILLED, active: undefined }
      )
    );

    await page.submit();
    assert.deepStrictEqual(page.messages(), []);
    assert.deepStrictEqual(sent.length, 1);
    assert.isFalse(sent[0]?.has("active"));
    page.unmount();
  });

  it("F3 control: a switch that is on is posted as a checkbox is", async () => {
    const sent: FormData[] = [];

    const page = mount(
      view(
        ({ data }) => {
          sent.push(data);

          return answered(success("Lagret."));
        },
        switchField,
        { ...FILLED, active: "on" }
      )
    );

    await page.submit();
    assert.strictEqual(sent[0]?.get("active"), "on");
    page.unmount();
  });
});
