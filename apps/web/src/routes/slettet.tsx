import { createFileRoute } from "@tanstack/react-router";

import { Card, CardContent, CardHeader } from "@/components/ui/card";

/** Where Min side leads after an erasure: the person has no account any more, so there is no page of theirs to show. */
const ErasedPage = () => (
  <main className="mx-auto grid min-h-svh max-w-md content-center px-4 py-12">
    <Card>
      <CardHeader>
        <h1 className="text-base leading-snug font-medium">
          Opplysningene dine er slettet
        </h1>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3">
          <p>
            Navnet, e-postadressene og kontoen din er slettet, og du er logget
            ut. Historikken om medlemskapet ditt blir stående uten navn og
            kontaktopplysninger.
          </p>
          <a href="/">Til forsiden</a>
        </div>
      </CardContent>
    </Card>
  </main>
);

export const Route = createFileRoute("/slettet")({
  component: ErasedPage,
  head: () => ({ meta: [{ title: "Slettet – Vektorprogrammet" }] }),
});
