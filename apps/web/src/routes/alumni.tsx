import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Schema } from "effect";

import { ConsentQuestions } from "@/components/consentQuestions";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { answerConsentByCode } from "@/functions/personalData.functions";

const Search = Schema.toStandardSchemaV1(
  Schema.Struct({ kode: Schema.optionalKey(Schema.String) })
);

const routeApi = getRouteApi("/alumni");

/** The page of the alumni e-mail (spec 0007b): the code in the link is the credential, so nobody signs in. */
const AlumniPage = () => {
  const { kode } = routeApi.useSearch();

  return (
    <main className="mx-auto grid min-h-svh max-w-xl content-center px-4 py-12">
      <Card>
        <CardHeader>
          <h1 className="text-base leading-snug font-medium">
            Takk for innsatsen i Vektorprogrammet
          </h1>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6">
            {kode === undefined || kode === "" ? (
              <p>Lenken mangler en kode.</p>
            ) : (
              <>
                <p>
                  Du er ikke lenger medlem eller assistent hos oss. Vi spør om
                  to ting. Du kan svare på ett eller begge, og du kan endre
                  svaret senere med samme lenke.
                </p>
                <ConsentQuestions
                  action={answerConsentByCode}
                  answers={null}
                  credential={{ name: "code", value: kode }}
                />
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </main>
  );
};

export const Route = createFileRoute("/alumni")({
  component: AlumniPage,
  head: () => ({
    meta: [{ title: "Svar om opplysningene dine – Vektorprogrammet" }],
  }),
  validateSearch: Search,
});
