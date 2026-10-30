// @vitest-environment happy-dom
/**
 * Spec 0010a F6 and the server side of F4: a form renders on the server with the values it was given, as a plain
 * `<form method="post">` that a browser without JavaScript can post, and with JavaScript the same schema validates
 * the values before the browser posts.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Predicate } from "effect";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

import { PostForm } from "../src/components/form/postForm";
import { Input } from "../src/components/ui/input";
import { ContactForm } from "../src/forms/contact";
import { typeInto } from "./support/typeInto";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const DEFAULTS = {
  departmentId: "3",
  email: "ola@example.com",
  message: "Hei",
  name: "Ola",
  subject: "Spørsmål",
};

const contactForm = (defaults = DEFAULTS) => (
  <PostForm
    action="/kontakt"
    defaults={defaults}
    id="skjema"
    schema={ContactForm.schema}
    serverIssues={{ email: ["Ugyldig e-post fra serveren."] }}
  >
    {(Field) => (
      <>
        <input name="departmentId" type="hidden" value="3" />
        <Field label="Ditt navn" name="name">
          <Input />
        </Field>
        <Field label="Din e-post" name="email">
          <Input type="email" />
        </Field>
        <button type="submit">Send</button>
      </>
    )}
  </PostForm>
);

describe("a form on the server", () => {
  it("F6: renders as a plain post form with the values it was given", () => {
    const html = renderToString(contactForm());

    assert.include(html, 'method="post"');
    assert.include(html, 'action="/kontakt"');
    assert.include(html, 'name="name"');
    assert.include(html, 'value="Ola"');
    assert.include(html, 'name="email"');
    assert.include(html, 'value="ola@example.com"');
    assert.include(html, 'name="departmentId"');
  });

  it("F6: renders the server's issue under its field, tied to the control", () => {
    const html = renderToString(contactForm());

    assert.include(html, "Ugyldig e-post fra serveren.");
    assert.include(html, 'aria-invalid="true"');
    assert.include(html, "aria-describedby=");
  });

  it("F6 control: the same markup shows no value that was not given", () => {
    const html = renderToString(
      contactForm({ ...DEFAULTS, email: "", name: "" })
    );

    assert.notInclude(html, 'value="Ola"');
    assert.notInclude(html, 'value="ola@example.com"');
  });
});

/** Renders into a detached element in `document`, as a page would be after hydration. */
const mount = (tree: ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  act(() => {
    root.render(tree);
  });

  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
};

/** What a post of `form` would carry, as `name=value` pairs. */
const carried = (form: HTMLFormElement): string =>
  Arr.join(
    Arr.map(
      Arr.fromIterable(new FormData(form).entries()),
      ([name, value]) => `${name}=${Predicate.isString(value) ? value : ""}`
    ),
    "&"
  );

/** Counts the posts that the browser is asked for: the form's own `submit` is replaced, as the real one would navigate. */
const posts = (container: HTMLElement) => {
  const calls: string[] = [];
  const form = container.querySelector("form");

  if (form !== null) {
    Object.defineProperty(form, "submit", {
      value: () => {
        calls.push(carried(form));
      },
    });
  }

  return calls;
};

const submit = async (container: HTMLElement) => {
  act(() => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
};

describe("a form in the browser", () => {
  it("F2/F3: refuses to post what the schema refuses, with the domain's message under the field", async () => {
    const page = mount(contactForm({ ...DEFAULTS, email: "ikke-en-adresse" }));
    const calls = posts(page.container);

    await submit(page.container);

    assert.deepStrictEqual(calls.length, 0);

    const messages = Arr.map(
      Arr.fromIterable(page.container.querySelectorAll("p.text-destructive")),
      (element) => element.textContent
    );

    assert.include(messages, "Ugyldig e-postadresse.");
    page.unmount();
  });

  it("F3 control: a valid form is posted by the browser, once, with what the markup holds", async () => {
    const page = mount(contactForm());
    const calls = posts(page.container);

    await submit(page.container);

    assert.deepStrictEqual(calls.length, 1);
    assert.include(calls[0], "name=Ola");
    assert.include(calls[0], "departmentId=3");
    page.unmount();
  });

  it("F3: a value that is typed is the value that is validated and posted", async () => {
    const page = mount(contactForm({ ...DEFAULTS, name: "" }));
    const calls = posts(page.container);

    const name =
      page.container.querySelector<HTMLInputElement>("input[name='name']");

    assert.isNotNull(name);

    if (name !== null) {
      typeInto(name, "Kari");
      assert.strictEqual(name.value, "Kari");
    }

    await submit(page.container);

    assert.deepStrictEqual(calls.length, 1);
    assert.include(calls[0], "name=Kari");
    page.unmount();
  });
});
