/**
 * Min side's two rights over a person's data (spec 0007b): a file of everything held (GDPR Art. 15 and 20) and the
 * erasure (Art. 17). The file is a plain form post to `/api/eksport`, so the browser saves what comes back; the erasure
 * waits behind a disclosure, because it cannot be undone.
 */
import { useNavigate } from "@tanstack/react-router";

import { CommandForm } from "@/components/form/commandForm";
import { Button } from "@/components/ui/button";
import { ErasePersonForm } from "@/forms/personalData";
import { erasePersonData } from "@/functions/personalData.functions";

export const OwnData = ({ personId }: { readonly personId: number }) => {
  const navigate = useNavigate();

  return (
    <div className="grid gap-6">
      <section className="grid gap-2">
        <h3 className="font-medium">Last ned opplysningene dine</h3>
        <p>
          Alt vi har lagret om deg i databasen vår, i én JSON-fil: profilen,
          kontoen, medlemskapene og samtykkene dine. Passordet og øktnøklene er
          ikke med.
        </p>
        <form action="/api/eksport" className="w-fit" method="post">
          <Button type="submit" variant="outline">
            Last ned opplysningene mine
          </Button>
        </form>
      </section>
      <section className="grid gap-2">
        <h3 className="font-medium">Slett opplysningene dine</h3>
        <p>
          Navnet, e-postadressene og kontoen din slettes, og samtykkene dine
          fjernes. Historikken om at du var medlem eller assistent blir stående
          uten navn og kontaktopplysninger. Handlingen kan ikke angres.
        </p>
        <details className="grid gap-3">
          <summary className="w-fit cursor-pointer font-medium">
            Jeg vil slette opplysningene mine
          </summary>
          <CommandForm
            action={erasePersonData}
            className="mt-3 grid gap-3"
            defaults={{ personId: String(personId) }}
            onSuccess={() => {
              void navigate({ to: "/slettet" });
            }}
            schema={ErasePersonForm.schema}
            submitLabel="Slett opplysningene mine"
          />
        </details>
      </section>
    </div>
  );
};
