import { PostForm } from "@/components/form/postForm";
import { Button } from "@/components/ui/button";
import { VerifyApplicantForm } from "@/forms/admission";
import { fieldErrors } from "@/lib/outcome";
import type { Failure } from "@/lib/outcome";

/**
 * The page of the verification link (spec 0009). With a code and no answer yet it shows one button, which is a plain
 * post of the code (a mail scanner that opens the link does not press it). A link that cannot be used is told as it is:
 * the reason is the same whether the code was wrong, used, expired or not yet ready, so the page names none.
 */
export const VerifyApplicant = ({
  code,
  done,
  failure,
}: {
  readonly code: string | undefined;
  readonly done: boolean;
  readonly failure: Failure | null;
}) => (
  <main className="mx-auto mt-10 mb-20 flex w-full max-w-xl flex-col gap-6 px-5">
    <h1 className="text-vektor-gray text-4xl font-bold">
      Bekreft e-postadressen
    </h1>
    {done && (
      <p
        className="bg-vektor-ok text-vektor-ok-ink rounded-md p-3"
        role="status"
      >
        Takk! E-postadressen din er bekreftet.
      </p>
    )}
    {failure !== null && (
      <p
        className="bg-vektor-error text-vektor-error-ink rounded-md p-3"
        role="alert"
      >
        {failure.message}
      </p>
    )}
    {!done && (code === undefined || code === "") && (
      <p>Lenken mangler en kode. Åpne lenken fra e-posten på nytt.</p>
    )}
    {!done && code !== undefined && code !== "" && (
      <PostForm
        action="/soknad/bekreft"
        className="grid gap-4"
        defaults={{ kode: code }}
        schema={VerifyApplicantForm.schema}
        serverIssues={fieldErrors(failure)}
      >
        {() => (
          <>
            <input name="kode" type="hidden" value={code} />
            <p>Trykk på knappen for å bekrefte at e-postadressen er din.</p>
            <Button className="w-fit" size="lg" type="submit">
              Bekreft e-postadressen
            </Button>
          </>
        )}
      </PostForm>
    )}
  </main>
);
