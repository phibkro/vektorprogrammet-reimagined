/**
 * The contact page, ported from mono-web's `ContactTabs` (`apps/homepage/src/components/kontakt-tabs.tsx`, commit
 * 2aa6ce97): department tabs, the department's details, and the form. The form is a plain HTML post to the page's
 * own URL, so it works without JavaScript (RULE-156, RULE-167 Turnstile, RULE-249); the server route answers a
 * success with 303 to the receipt and a failure by showing this page again with the visitor's values and the
 * messages (`server/contactPost.ts`). Turnstile's own widget script is the only script it needs.
 */
import { Link } from "@tanstack/react-router";
import { Array as Arr } from "effect";
import { Mail, MapPin } from "lucide-react";

import { Field, FieldErrorsProvider } from "@/components/forms";
import { departmentLinkClass } from "@/components/site/pageParts";
import { PortableTextView } from "@/components/site/portableTextView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fieldErrors } from "@/lib/outcome";
import type { ContactFormState } from "@/server/contactPost";
import type { ContactPageView } from "@/server/site/pages";

export const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js";

export const ContactTabs = ({
  formState,
  view,
}: {
  readonly view: ContactPageView & { readonly turnstileSiteKey: string };
  readonly formState: ContactFormState | null;
}) => {
  const { departments, notice, selected, texts } = view;
  const values = formState?.values;

  return (
    <div className="mx-auto mt-10 mb-20 flex max-w-6xl flex-col items-center">
      <header className="mx-auto flex w-full flex-col px-5">
        <h1 className="text-vektor-gray text-4xl font-bold">Kontakt oss</h1>
        <PortableTextView
          className="mt-4 mb-10 max-w-2xl text-xl"
          value={texts["contact-header"] ?? null}
        />
      </header>
      <div className="mb-6 flex w-full flex-col gap-8 px-5 md:max-w-6xl lg:flex-row">
        <nav
          aria-label="Velg avdeling"
          className="flex min-w-48 flex-wrap gap-2 lg:flex-col"
        >
          {Arr.map(departments, (department) => (
            <Link
              aria-current={department.id === selected.id ? "page" : undefined}
              className={departmentLinkClass(department.id === selected.id)}
              key={department.id}
              params={{ department: department.slug }}
              to="/kontakt/$department"
            >
              {department.shortName}
            </Link>
          ))}
        </nav>
        <section className="grid w-full min-w-0 grid-cols-1 gap-8 rounded-md border p-6 lg:grid-cols-2">
          <div className="min-w-0">
            <h2 className="text-vektor-link text-2xl font-bold">
              {selected.name}
            </h2>
            <div className="mt-5 flex items-center gap-2">
              <Mail aria-hidden="true" className="size-5" />
              <a
                className="break-all hover:underline"
                href={`mailto:${selected.email}`}
              >
                {selected.email}
              </a>
            </div>
            {selected.address !== null && selected.address !== "" && (
              <div className="mt-3 flex gap-2">
                <MapPin aria-hidden="true" className="size-5 shrink-0" />
                <span>{selected.address}</span>
              </div>
            )}
            <p className="mt-3">{selected.city}</p>
          </div>
          <div className="min-w-0">
            <h2 className="text-vektor-link text-2xl font-bold">
              {`Kontakt ${selected.shortName}`}
            </h2>
            {notice !== null && (
              <p
                className="bg-vektor-ok text-vektor-ok-ink mt-4 rounded-md p-3"
                role="status"
              >
                {notice}
              </p>
            )}
            {formState !== null && (
              <p
                className="bg-vektor-error text-vektor-error-ink mt-4 rounded-md p-3"
                id="kontaktskjema-feil"
                role="alert"
              >
                {formState.failure.message}
              </p>
            )}
            <form className="mt-5 grid gap-5" id="kontaktskjema" method="post">
              <input name="departmentId" type="hidden" value={selected.id} />
              <FieldErrorsProvider errors={fieldErrors(formState?.failure)}>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="Ditt navn" name="name">
                    <Input
                      autoComplete="name"
                      defaultValue={values?.name}
                      id="name"
                      maxLength={255}
                      name="name"
                      required
                    />
                  </Field>
                  <Field label="Din e-post" name="email">
                    <Input
                      autoComplete="email"
                      defaultValue={values?.email}
                      id="email"
                      name="email"
                      required
                      type="email"
                    />
                  </Field>
                </div>
                <Field label="Emne" name="subject">
                  <Input
                    defaultValue={values?.subject}
                    id="subject"
                    maxLength={255}
                    name="subject"
                    required
                  />
                </Field>
                <Field label="Melding" name="message">
                  <Textarea
                    defaultValue={values?.message}
                    id="message"
                    name="message"
                    required
                    rows={6}
                  />
                </Field>
                <Field label="Bekreft at du ikke er en robot" name="captcha">
                  {view.turnstileSiteKey === "" ? (
                    <p className="text-sm">
                      Spambeskyttelse er ikke konfigurert.
                    </p>
                  ) : (
                    <div
                      className="cf-turnstile"
                      data-sitekey={view.turnstileSiteKey}
                      id="captcha"
                    />
                  )}
                </Field>
              </FieldErrorsProvider>
              <Button type="submit">Send melding</Button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
};
