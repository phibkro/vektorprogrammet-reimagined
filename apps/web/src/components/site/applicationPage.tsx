/**
 * The public application pages (spec 0009): `/soknad` lists the departments and whether their admission is open, and
 * `/soknad/{department}` holds the form while it is. The form is a plain HTML post to the page's own URL, so it works
 * without JavaScript (RULE-105, 167): the server route answers a success with 303 to the receipt and a failure by showing
 * the page again with what was typed and the messages (`server/admissionPost.ts`). The page shows the privacy notice that
 * the domain generates from the form's declaration, and the Turnstile widget is the contact page's.
 */
import { Turnstile } from "@marsidev/react-turnstile";
import { Link } from "@tanstack/react-router";
import { Array as Arr } from "effect";
import type { Effect } from "effect";

import { ApplicantFields } from "@/components/admission/applicantFields";
import { PostForm } from "@/components/form/postForm";
import { ContactPrivacy } from "@/components/site/contactPrivacy";
import { greenButtonClass } from "@/components/site/pageParts";
import { Button } from "@/components/ui/button";
import { ApplicationForm } from "@/forms/admission";
import { fieldErrors } from "@/lib/outcome";
import type { applicationPage, applyIndexPage } from "@/server/admission";
import type { ApplicationFormState } from "@/server/admissionPost";

export const ApplyIndex = ({
  view,
}: {
  readonly view: Effect.Success<typeof applyIndexPage>;
}) => {
  const open = Arr.filter(
    view.departments,
    (department) => department.admissionOpen
  );

  return (
    <main className="mx-auto mt-10 mb-20 flex w-full max-w-3xl flex-col gap-6 px-5">
      <h1 className="text-vektor-gray text-4xl font-bold">
        Søk om å bli assistent
      </h1>
      <p className="text-xl">
        Du søker til en avdeling mens avdelingens opptak er åpent. Velg
        avdelingen du vil søke til.
      </p>
      {open.length === 0 ? (
        <p role="status">Ingen avdelinger har åpent opptak akkurat nå.</p>
      ) : (
        <nav aria-label="Åpent opptak" className="flex flex-wrap gap-3">
          {Arr.map(open, (department) => (
            <Link
              className={greenButtonClass}
              key={department.id}
              params={{ department: department.slug }}
              to="/soknad/$department"
            >
              {`Søk i ${department.shortName}`}
            </Link>
          ))}
        </nav>
      )}
    </main>
  );
};

export const ApplicationPageView = ({
  formState,
  turnstileSiteKey,
  view,
}: {
  readonly formState: ApplicationFormState | null;
  readonly turnstileSiteKey: string;
  readonly view: Effect.Success<ReturnType<typeof applicationPage>>;
}) => {
  const { department } = view;

  return (
    <main className="mx-auto mt-10 mb-20 flex w-full max-w-3xl flex-col gap-6 px-5">
      <h1 className="text-vektor-gray text-4xl font-bold">
        {`Søk i ${department.name}`}
      </h1>
      {view.sent && (
        <p
          className="bg-vektor-ok text-vektor-ok-ink rounded-md p-3"
          role="status"
        >
          Takk! Vi har mottatt søknaden din. Vi har sendt deg en e-post med en
          lenke som bekrefter e-postadressen din.
        </p>
      )}
      {!view.sent && !department.admissionOpen && (
        <p role="status">
          Opptaket i {department.name} er ikke åpent akkurat nå.{" "}
          <Link to="/soknad">Se hvilke avdelinger som har åpent opptak.</Link>
        </p>
      )}
      {!view.sent && department.admissionOpen && (
        <>
          {formState !== null && (
            <p
              className="bg-vektor-error text-vektor-error-ink rounded-md p-3"
              id="soknadsskjema-feil"
              role="alert"
            >
              {formState.failure.message}
            </p>
          )}
          <PostForm
            className="grid gap-5"
            defaults={{
              departmentId: String(department.id),
              ...formState?.values,
            }}
            id="soknadsskjema"
            schema={ApplicationForm.schema}
            serverIssues={fieldErrors(formState?.failure)}
          >
            {(Field) => (
              <>
                <input
                  name="departmentId"
                  type="hidden"
                  value={department.id}
                />
                <ApplicantFields
                  Field={Field}
                  options={{
                    answers: view.choices,
                    consent: view.consent,
                    fieldsOfStudy: view.options.fieldsOfStudy,
                    teams: view.options.teams,
                  }}
                />
                <Field label="Bekreft at du ikke er en robot" name="captcha">
                  {turnstileSiteKey === "" ? (
                    <p className="text-sm">
                      Spambeskyttelse er ikke konfigurert.
                    </p>
                  ) : (
                    <div data-turnstile>
                      <Turnstile siteKey={turnstileSiteKey} />
                    </div>
                  )}
                </Field>
                <ContactPrivacy notice={view.privacy} />
                <Button className="w-fit" size="lg" type="submit">
                  Send søknad
                </Button>
              </>
            )}
          </PostForm>
        </>
      )}
    </main>
  );
};
