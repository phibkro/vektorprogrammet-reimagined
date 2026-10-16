import { Array as Arr, pipe } from "effect";

import {
  Field,
  FieldErrorsProvider,
  SanitizedHtmlBlock,
  nativeSelectClass,
} from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fieldErrors } from "@/lib/outcome";
import type { ContactFormState } from "@/server/contactPost";
import type { ContactPageView } from "@/server/pages";

export const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js";

/**
 * C10 contact form. A plain HTML form post to the current URL, so it works
 * without the app's JavaScript; Turnstile's own widget script is the only
 * script it needs (RULE-167: no token → rejected).
 */
export const ContactPage = ({
  view,
  departmentId,
  formState,
}: {
  view: ContactPageView & { readonly turnstileSiteKey: string };
  departmentId: number | null;
  formState: ContactFormState | null;
}) => {
  const values = formState?.values;

  const selected =
    values?.departmentId ?? (departmentId === null ? "" : String(departmentId));

  return (
    <main className="page-wrap grid gap-8 px-4 py-12">
      <SanitizedHtmlBlock html={view.blocks["contact-header"] ?? null} />
      {view.notice !== null && (
        <p role="status" className="bg-sidebar text-chart-3 rounded-lg p-4">
          {view.notice}
        </p>
      )}
      {formState !== null && (
        <p
          role="alert"
          id="kontaktskjema-feil"
          className="bg-muted text-destructive rounded-lg p-4"
        >
          {formState.failure.message}
        </p>
      )}
      <form method="post" id="kontaktskjema" className="grid max-w-xl gap-4">
        <FieldErrorsProvider errors={fieldErrors(formState?.failure)}>
          <Field name="departmentId" label="Avdeling">
            <select
              id="departmentId"
              name="departmentId"
              defaultValue={selected}
              className={nativeSelectClass}
              required
            >
              <option value="" disabled>
                Velg avdeling
              </option>
              {pipe(
                view.departments,
                Arr.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))
              )}
            </select>
          </Field>
          <Field name="name" label="Ditt navn">
            <Input
              id="name"
              name="name"
              defaultValue={values?.name}
              required
              maxLength={255}
            />
          </Field>
          <Field name="email" label="Din e-post">
            <Input
              id="email"
              name="email"
              type="email"
              defaultValue={values?.email}
              required
            />
          </Field>
          <Field name="subject" label="Emne">
            <Input
              id="subject"
              name="subject"
              defaultValue={values?.subject}
              required
              maxLength={255}
            />
          </Field>
          <Field name="message" label="Melding">
            <Textarea
              id="message"
              name="message"
              rows={9}
              defaultValue={values?.message}
              required
            />
          </Field>
          <Field name="captcha" label="Bekreft at du ikke er en robot">
            {view.turnstileSiteKey === "" ? (
              <p className="text-sea-ink-soft text-sm">
                Spambeskyttelse er ikke konfigurert.
              </p>
            ) : (
              <div
                id="captcha"
                className="cf-turnstile"
                data-sitekey={view.turnstileSiteKey}
              />
            )}
          </Field>
        </FieldErrorsProvider>
        <Button type="submit">Send melding</Button>
      </form>
    </main>
  );
};
