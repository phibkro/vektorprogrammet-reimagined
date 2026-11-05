/**
 * Spec 0010a F1: there is one form construct. A form of `apps/web` is made by `components/form/` (`CommandForm`,
 * `PostForm`, `LocalForm`, over `useConstructForm`), from a schema of `forms/`; nothing else builds a `<form>` that has
 * inputs, reads one by name, or touches TanStack Form. The scan reads the source of `apps/web` for the three signs of a
 * second construct: a `<form` element, a read of a field by name from a `FormData` (`.get("…")`), and an import of
 * `@tanstack/react-form`. A file with an unlisted sign fails, as does a stale listing.
 * Native Supabase invitation and recovery forms handle credentials outside the domain form construct.
 * The inventory also names their text reader and the button-only export form.
 *
 * What it does not see: a form built by `React.createElement("form")`, or a field read through a variable. It is the
 * early signal at review time, as the other scans of this directory are.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Order } from "effect";

import {
  assertCleanScan,
  isWebSource,
  repositoryRoot,
  signFindings,
} from "./support/sources.ts";
import type { Sign, Source } from "./support/sources.ts";

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
      "apps/web/src/features/personal-data/components/ownData.tsx":
        "the export of one's own data: a button, posted to /api/eksport, with no input",
      "apps/web/src/routes/aktiver.tsx":
        "native POST for a Supabase invitation session; it works without JavaScript",
      "apps/web/src/routes/tilbakestill-passord.tsx":
        "Supabase recovery-token password update; the native POST prevents pre-hydration URL leakage",
    },
    pattern: /<form[\s>]/u,
  },
  "a field read by name from a FormData": {
    allowed: {
      "apps/web/src/forms/formSchema.ts":
        "`textOf` is the one reader of a posted FormData",
      "apps/web/src/utils/formText.ts":
        "text reader for the Supabase recovery password form; files and missing values are refused as empty",
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
} satisfies Readonly<Record<string, Sign>>;

const { stale, unlisted } = signFindings(SIGNS);

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
      stale([
        {
          path: "apps/web/src/features/personal-data/components/ownData.tsx",
          text: "<div />",
        },
      ]).length,
      0
    );
  });

  it.effect(
    "the real tree: every sign is in a listed file, and every listing is used",
    () => assertCleanScan(repositoryRoot, isWebSource, { stale, unlisted })
  );
});
