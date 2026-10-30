/**
 * Spec 0010a F1: there is one form construct. A form of `apps/web` is made by `components/form/` (`CommandForm`,
 * `PostForm`, `LocalForm`, over `useConstructForm`), from a schema of `forms/`; nothing else builds a `<form>` that has
 * inputs, reads one by name, or touches TanStack Form. The scan reads the source of `apps/web` for the three signs of a
 * second construct: a `<form` element, a read of a field by name from a `FormData` (`.get("…")`), and an import of
 * `@tanstack/react-form`. A file that has one and is not listed fails, and so does a listing that no file needs, so the
 * list can only shrink. The allowed `<form` is a form that has no input but a button (the export of one's own data posts
 * to `/api/eksport`), and the allowed reads are `textOf` itself and the Turnstile token of an account post.
 *
 * What it does not see: a form built by `React.createElement("form")`, or a field read through a variable. It is the
 * early signal at review time, as the other scans of this directory are.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Order, Record as Rec } from "effect";

import { assertCleanScan, repositoryRoot } from "./support/sources.ts";
import type { Source } from "./support/sources.ts";

/** What each sign is, the pattern that finds it, and the files that may have it, each with why. */
const SIGNS = {
  "a <form> element": {
    allowed: {
      "apps/web/src/components/form/commandForm.tsx":
        "the form for a server function",
      "apps/web/src/components/form/localForm.tsx":
        "the form for a client library",
      "apps/web/src/components/form/postForm.tsx":
        "the form that the browser posts",
      "apps/web/src/components/ownData.tsx":
        "the export of one's own data: a button, posted to /api/eksport, with no input",
    },
    pattern: /<form[\s>]/u,
  },
  "a field read by name from a FormData": {
    allowed: {
      "apps/web/src/forms/formSchema.ts":
        "`textOf` is the one reader of a posted FormData",
      "apps/web/src/server/accountPost.ts":
        "the Turnstile token of an account post, which is the widget's field and no value of a form",
    },
    pattern: /\b(?:form|data)\.get\(/u,
  },
  "an import of @tanstack/react-form": {
    allowed: {
      "apps/web/src/components/form/useConstructForm.ts":
        "the one place a form is built on TanStack Form",
    },
    pattern: /from "@tanstack\/react-form"/u,
  },
} satisfies Readonly<
  Record<
    string,
    {
      readonly allowed: Readonly<Record<string, string>>;
      readonly pattern: RegExp;
    }
  >
>;

const signs = Rec.keys(SIGNS);

/** The source that the scan reads: the `src` of the web app. */
const isSource = (path: string): boolean =>
  /^apps\/web\/src\/.*\.tsx?$/u.test(path);

const allowedFor = (
  sign: keyof typeof SIGNS
): Readonly<Record<string, string>> => SIGNS[sign].allowed;

/** `file has Sign` for each file that has a sign and is not allowed to. */
const unlisted = (sources: readonly Source[]): readonly string[] =>
  Arr.flatMap(sources, ({ path, text }) =>
    Arr.flatMap(signs, (sign) =>
      SIGNS[sign].pattern.test(text) && allowedFor(sign)[path] === undefined
        ? [`${path} has ${sign}`]
        : []
    )
  );

/** `file is allowed Sign` for each allowance whose file does not have the sign. */
const stale = (sources: readonly Source[]): readonly string[] =>
  Arr.flatMap(signs, (sign) =>
    Arr.flatMap(Rec.keys(allowedFor(sign)), (path) =>
      Arr.some(
        sources,
        (source) =>
          source.path === path && SIGNS[sign].pattern.test(source.text)
      )
        ? []
        : [`${path} is allowed ${sign} and does not have it`]
    )
  );

describe("spec 0010a F1: one form construct", () => {
  it("control: a hand-made form, a hand-read field and a second import of TanStack Form are reported, the construct itself is not", () => {
    const sources: readonly Source[] = [
      {
        path: "apps/web/src/routes/kontrollpanel/ny.tsx",
        text: 'const x = <form onSubmit={save}><input name="a" /></form>;',
      },
      {
        path: "apps/web/src/server/ny.ts",
        text: 'const name = form.get("name");',
      },
      {
        path: "apps/web/src/components/ny.tsx",
        text: 'import { useForm } from "@tanstack/react-form";',
      },
      {
        path: "apps/web/src/components/form/postForm.tsx",
        text: '<form method="post" />',
      },
      {
        path: "apps/web/src/routes/ok.tsx",
        text: "const formatted = <formal />;",
      },
    ];

    assert.deepStrictEqual(Arr.sort(unlisted(sources), Order.String), [
      "apps/web/src/components/ny.tsx has an import of @tanstack/react-form",
      "apps/web/src/routes/kontrollpanel/ny.tsx has a <form> element",
      "apps/web/src/server/ny.ts has a field read by name from a FormData",
    ]);
  });

  it("control: an allowance whose file no longer has the sign is reported", () => {
    assert.isAbove(
      stale([{ path: "apps/web/src/components/ownData.tsx", text: "<div />" }])
        .length,
      0
    );
  });

  it.effect(
    "the real tree: every sign is in a listed file, and every listing is used",
    () => assertCleanScan(repositoryRoot, isSource, { stale, unlisted })
  );
});
