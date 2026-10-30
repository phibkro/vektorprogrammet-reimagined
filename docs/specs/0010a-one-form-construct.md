# Spec 0010a: One form construct (TanStack Form over Effect Schema)

**Status:** built; frozen when its PR opens; later changes are dated entries under [Revisions](#revisions) · **Source:** operator decision (2026-10-26, INFORMATION_MODEL §11.10 and §11.11: TanStack Form, Standard Schema, one form construct, the form schema as the one validator on both sides); the draft of spec 0010 (its falsifier 7, which this spec takes out of it); lead's go (2026-10-30), with the order 0010a → 0009 → 0009b → 0010 → 0010b.

## Problem

`apps/web` builds forms three ways, and the two specs that come next (0009's public application form, 0010's versioned interview forms) would add a fourth if nothing changes:

1. **Panel and Min side forms** (`CommandForm`, `CommandSheet`, `Field`, `OutcomeMessages` in `components/forms.tsx`, 272 lines): 28 uses in 11 files, 43 `Field`s. They post `FormData` to a server function and show what the server says. The browser's own validation is off, so a wrong input costs a round trip, and the rules exist only after it.
2. **Native posts** that work without JavaScript: the contact form (`/kontakt`), forgot password, the code form. Each decodes on its own.
3. **Better Auth's two forms** (sign in, change password), which call the auth client from `onSubmit`.

The text → payload step of every panel form is a hand-written mapper on the server (`departmentInput`, `fieldOfStudyInput`, `socialEventInput`, `saveTeamProgram`, …: about twenty programs take a `FormData` and turn text into numbers, nulls, booleans and UTC instants with `optionalText`, `checkbox`, `integer` and `osloLocalToIso` of `server/panel.ts`). What a field _is_ lives in a mapper, apart from the domain schema that says what it may hold, and nothing says that a browser would read it the same way.

## Journey

1. **A person fills a form** (any form of the app). A wrong input is refused at once, under its field, with the domain's own message, before a request leaves; the server refuses the same input with the same message when a request does arrive (a forged one, or a browser with no script).
2. **Without JavaScript** the contact form, the forgot-password form and the code form still post and come back with the field messages (unchanged to the person).
3. **In the control panel** a form in a Sheet behaves as today: a refusal stays in the Sheet with its message and saves nothing; a success closes it and the table behind it already shows the change.
4. **A developer adds a form** with one schema (what the inputs hold, and what the domain takes from them) and one `useAppForm`; there is no second place to say what a field is.

## Goal, constraints, values

- **Goal:** one way to build a form, with one schema per form that both the browser and the server decode with.
- **Constraints:**
  - **The library is `@tanstack/react-form` 1.33.5** (client state, Standard Schema validators), pinned in the root `catalog`. **Deviation from §11.11, which names `@tanstack/react-form-start` (approved by the lead, 2026-10-30):** `react-form-start` adds a server function of its own, a cookie and a redirect to carry the errors of a post without script, plus `devalue` and `decode-formdata`. We have that path already (the server decodes the post and the page comes back with `formStatus` 422 and its field messages), so adopting it would add a second no-script mechanism beside ours. It re-exports `@tanstack/react-form`, so a later switch is one import path.
  - **The schema of a form** decodes the record that its inputs hold (every value text; a checkbox is present or absent, as in a `FormData`) to the typed payload of the domain command, and **composes the command's own payload schema after the text step**: the rules and the Norwegian messages are the domain's, not copies. It lives in `apps/web/src/forms/` (pure, imports `effect` and `@vektorprogrammet/domain` only), one file per group of forms, and is imported by the component and by the server program.
  - **One transport, `FormData`.** A form submits a `FormData` built from its values; the server functions keep their signature (`.validator(formData)`) and their programs keep taking a `FormData` (the tests that call them with one keep their shape). The hand-written mappers are replaced by the form's `read(formData)` (the text step; the command's endpoint decodes the result with the payload schema). A native post is read by the same function.
  - **Client and server read the same issues.** The client validator is `Schema.toStandardSchemaV1(schema, { parseOptions: { errors: "all" } })`; the server turns a decode failure into `ValidationFailed` with `fromSchemaError`, whose formatter is `SchemaIssue.makeFormatterStandardSchemaV1`, the one the Standard Schema adapter uses. Paths are the field names.
  - **The server stays the authority.** Each command decodes its own payload inside its transaction as before; a form schema only gives the early, identical verdict. A refusal that only the server can give (a duplicate, `Forbidden`, a missing row) comes back as an `Outcome` and is put on the form: a `ValidationFailed` issue on its field (R2), every other message, and an issue on a path that no `Field` renders (issue 26), in the form's one alert, as `OutcomeMessages` does today.
  - **The components keep the DOM that the browser tests read**: the label wraps its control, `aria-invalid` and `aria-describedby` name the messages, the submit button is labelled as now. They live in `components/form/` (`useConstructForm`, `Field`, `FormAlert`, `CommandForm`, `PostForm`, `LocalForm`, `Choice`; `CommandSheet` stays in `components/panel/panelSheets.tsx`) on the shadcn controls, and **`components/forms.tsx` is deleted.**
  - **No script, native posts.** The contact, forgot-password and code forms keep `method="post"` and their server routes; the hydrated page adds the client validator. The Turnstile step and the rate limit stay before any transaction (spec 0009's rule, already true here).
  - **Better Auth's forms** use the same construct (`LocalForm`) and schema, and submit to the auth client as now; what the client answers stays the page's own message (R2).
  - **The social-event page** (removed by the later spec 0014) is migrated like the rest: `forms.tsx` cannot be deleted while a caller is left.
- **Values:** one definition of what a field is; the person sees the same verdict from the client and the server; a form that never reaches the server is not a form that is allowed to be wrong.

## What is out of scope

- The dynamic forms of spec 0010 (`answersSchema(version)`), the application form of spec 0009 and its alerts: they are built on this construct afterwards.
- A form builder, drag and drop, file uploads (no form has a file field today).
- Changing what any form asks, its labels, its rules or its routes. A change of wording is a bug of this spec.
- Better Auth's own pages (`@better-auth-ui`), which we do not render ourselves.

## Failure cases

| Case | What happens |
| --- | --- |
| The client accepts what the server refuses (a duplicate, a missing row) | the server's `Outcome` is put on the form: the field's message under it, any other in the alert; the Sheet stays open |
| The client refuses what the server would accept | cannot happen by construction: one schema. The agreement test (F2) is the check |
| A `ValidationFailed` issue on a path that no `Field` renders (a hidden `id`) | the form's alert shows it (issue 26) |
| The page is loaded and the script has not run yet | the native post path decodes the same schema; the person sees the field messages after the reload |
| A forged post that skips the browser | the server decodes with the schema; the same issues |
| The server function crashes or the network fails | the form's alert says "Noe gikk galt. Prøv igjen senere."; the values stay |

## Falsifiers

| # | Falsifier | Negative control | Where |
| --- | --- | --- | --- |
| F1 | **One construct.** `components/forms.tsx` does not exist; no file imports it; every `<form` element, every field read by name from a `FormData` and every import of `@tanstack/react-form` in `apps/web/src` is in the one allowance list (the three form components, the export button of Min side, the Turnstile token of an account post, the contact echo, `textOf`, `useConstructForm`) | a planted `<form`, a planted `.get("name")` and a planted import are each reported, and an allowance that no file needs is reported | `tools/quality/test/oneFormConstruct.test.ts` (a source scan with an allowance list that can only shrink) |
| F2 | **Client and server agree.** For seven forms of every kind, over values that are wrong in several ways, the client validator's issues (path and message) equal the issues that the command's own decoder gives for the posted `FormData` read by the form | a form whose payload is not the command's is reported (the browser accepts, the server refuses) | `apps/web/test/formAgreement.test.ts` |
| F3 | **Errors reach the right place.** A server `ValidationFailed` for a path shows under its `Field` once (`aria-invalid`, `aria-describedby`); one for a path that no field renders shows in the alert, and follows the fields on screen; a crash says "Noe gikk galt"; a form that the schema refuses sends nothing | the same form with valid values sends its values once; an issue shown in the wrong place fails the test | `apps/web/test/formMessages.test.tsx`, `formRender.test.tsx`, the existing browser specs |
| F4 | **No script.** With JavaScript off, the contact form and the code form post their markup (the visitor's values are still in the page that answers), and the forgot-password form reaches its endpoint | the page is checked to hold no React fiber; a post with a missing token leaves no row | `apps/web/e2e/public.spec.ts`, `accounts.spec.ts` (a JS-off case each); the server render in `formRender.test.tsx` |
| F5 | **The browser specs stay green with their locators unchanged** (`journey`, `shell`, `teams`, `admins`, `accounts`, `personalData`, `integrations`, `public`, `impact`). A test that asserted a server round trip for a refusal that the client now gives earlier is changed and listed in the Revisions | — | `apps/web/e2e/*` |
| F6 | **It builds and renders.** `vp build` (the Worker bundle) includes the library; a server render of a form shows its default values, a plain `method="post"`, the server's issue under its field and no crash | a render without the given values shows none of them | `vp build`, `apps/web/test/formRender.test.tsx`, CI |
| F7 | **Accessibility parity.** The label wraps its control in every `Field` (the DOM that the browser specs read), and an invalid one has `aria-invalid` and a described-by that names its messages | a field that is not the one named has neither | `apps/web/test/formMessages.test.tsx` |
| F8 | **Nothing else moved.** `vp check`, `bun run ready`, the module graph, the exception registry | — | CI |

## Open items

1. **`react-form` or `react-form-start`**: decided by the lead (2026-10-30): `react-form`.
2. **The Better Auth forms**: resolved in R2: no fallback was needed.

## Revisions

### R1 (2026-10-30): first plan

Written after reading `components/forms.tsx`, the callers (28 uses in 11 files), the server mappers of `server/panel.ts`, `teams.ts` and `personalData.ts`, `packages/domain/src/shared/validation.ts` (the formatter the domain uses is the one the Standard Schema adapter uses), the installed `@tanstack/react-form-start` 1.33.5 (its source), and a throwaway route that built with `vp build` through the Worker bundle (route chunk 59.7 kB, no error). Peer ranges: `@tanstack/react-form` asks for `react ^17 || ^18 || ^19`; `react-form-start` asks for `@tanstack/react-start ^1.168.27`, which admits the pinned 1.169.2.

### R2 (2026-10-30): what was built, and what the build changed in the plan

The lead approved the two deviations asked for in R1 (`react-form` over `react-form-start`; `FormData` stays the transport, the hand mappers become schemas) and the order of work. The build changed these things, each of which the text above now says:

- **`decodeForm(schema)(formData)` is not built; `read` is.** A form is `formSchema(from, payload, map)` (`forms/formSchema.ts`). `payload` is the command's own `payloadSchema` (`Teams.createMembership.payloadSchema`, …), `from` says which names the inputs hold, and `map` is the text step (blank to null, digits to a number, `HOST-2026` to a semester, an Oslo wall-clock time to an instant). It returns `schema` (for the browser: values in, payload out), `read(formData)` (for the server: the payload's _encoded_ form) and `payloadOf(values)`. The server does not decode a second time: `Commands.endpoint` already decodes its input with `payloadSchema` and gives `ValidationFailed`, so `read` only runs the text step and the endpoint is the one server-side decode. Client and server therefore share the text step and the payload schema, and F2 compares their issues.
- **The text step is typed against the payload.** `map` must return `Widen<payload.Encoded>` (each literal widened to its kind: a team function is any text, a term any number), so a field that is missing or of another kind is a compile error. Text that is no number is `NaN` and text that is no semester is a semester with no year; the domain's schema refuses both in its own words. This changes one message for the worse and none for the better: a latitude that is not a number said `Expected number, got "abc"`, and now says what the schema says of `NaN`.
- **Native selects, not Base UI `Select`.** No form of the app uses Base UI's `Select`; every choice is a native `<select>` (`components/form/choice.tsx`), so the open item "controlled Base UI `Select`" has nothing to check. `Switch` and `Checkbox` (sign-in's "Husk meg") are bound as controlled (`checked`, `onCheckedChange`) and hold `"on"` or nothing, as a posted checkbox does.
- **Errors from the server** are not put on the form with `form.setErrorMap`. They are the outcome's `ValidationFailed` issues, given to the `Field`s by a context (`ServerIssuesContext`) and shown beside the client's messages; an issue on a path that no `Field` renders is in the form's alert, by the registration of rendered `Field`s that `OutcomeMessages` had (issue 26, `FormAlert`, `RegisterFieldContext`). A `Field` shows the union of both, without duplicates.
- **Four forms, one hook.** `useConstructForm` is the one place that touches TanStack Form. `CommandForm` (a server function; `CommandFormView` is the same without the router, so it can be rendered in a test), `PostForm` (a `<form method="post">` that the browser posts when the schema accepts the values; without script it is just the markup) and `LocalForm` (a client library: the two Better Auth forms) differ only in what a valid submission does. `CommandSheet` is `CommandForm` in a Sheet. Better Auth's forms needed no form-level fallback: their answers were never field messages (sign-in says "Feil e-post eller passord." on purpose), and the change-password form now shows the domain's `Password` message under the field where it showed a form-level "Passordet oppfyller ikke kravene."
- **Account posts read through the forms.** `server/accountPost.ts` read `form.get("email")`, `form.get("password")` and `form.get("code")` by hand; it now reads `RequestResetForm` and `ChoosePasswordForm`.
- **`lib/formText.ts` is deleted** with `forms.tsx` and the mappers (`optionalText`, `checkbox`, `integer`, `osloLocalToIso`, `semesterOfChoice` of `server/`); `hasValue(form, "id")` says which of create and change a form is.
- **F1 lives in `tools/quality/test/oneFormConstruct.test.ts`**, beside the other source scans, and scans for three signs (a `<form` element, a field read by name from a `FormData`, an import of `@tanstack/react-form`) with an allowance list that can only shrink. F2 is a table of seven forms (a department, the contact form, an added member, an admin place, a social event, a chosen password, a consent without an answer), each posted with values that are wrong in several ways, not generated records.
- **Config.** `vite.config.ts` lists the new files in the three places that list a Promise boundary (TanStack's `onSubmit` returns a Promise, and a server function is a Promise), and the two happy-dom tests among the browser-platform tests; `forms.tsx` left them.

- **What the browser specs found, and changed.** A switch that is off holds `undefined`, and a text value that is a missing key (`Schema.optionalKey`) refuses an explicit `undefined` with "Expected string", so every form with a switch or a checkbox (a department's `Aktiv`, a membership's `Leder`, sign-in's `Husk meg`) could not be sent; the first browser run showed six failing specs. `Text` is `Schema.optional(Schema.String)`, and `formMessages.test.tsx` has the case (with its control: put back `optionalKey`, and the test fails with "Expected string"). Three specs forged or read a _hidden input_ of a form (`journey` falsifier 5 and `personalData` change the hidden id or person id before the click; `teams` read the membership id from the extend Sheet), and a form now holds its hidden values in its state, not in the page. `tamperWith` (`e2e/support/panel.ts`) rewrites the part of the next server function call (the multipart field of that name, as the browser would have sent it), which is what forging a hidden value always meant, and `teams.spec.ts` reads the id from the database. No locator of a spec changed, and no assertion of a refusal.

What was measured: `vp build` of the Worker bundle with the library passes; the client chunk that holds TanStack Form and the construct (`useConstructForm-*.js`, loaded by the pages that have a form) is 71.6 kB, 18.6 kB gzipped, and `effect`'s `Schema` (79.8 kB, 23.7 kB gzipped) now reaches the browser on those pages (not measured on `main`). `bun run ready` and the full browser run (65 tests) pass on the head of the pull request.
