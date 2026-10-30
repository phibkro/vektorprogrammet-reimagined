import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Schema } from "effect";

import { VerifyApplicant } from "@/components/site/verifyApplicant";
import { handleVerifyPost } from "@/server/admissionPost";

const Search = Schema.toStandardSchemaV1(
  Schema.Struct({
    bekreftet: Schema.optionalKey(Schema.Literals([1, "1"])),
    kode: Schema.optionalKey(Schema.String),
  })
);

const routeApi = getRouteApi("/soknad/bekreft");

const VerifyRoute = () => {
  const { bekreftet, kode } = routeApi.useSearch();
  const { failure } = routeApi.useLoaderData();

  return (
    <VerifyApplicant
      code={kode}
      done={bekreftet !== undefined}
      failure={failure}
    />
  );
};

/**
 * Spec 0009: the page of the link in the application's mail. It shows one button that posts the code, so a mail scanner
 * that opens the link spends nothing (the code is single use). A code that cannot be used says so; the applicant's
 * application is kept and the address stays unverified until a link works.
 */
export const Route = createFileRoute("/soknad/bekreft")({
  component: VerifyRoute,
  head: () => ({ meta: [{ title: "Bekreft e-post – Vektorprogrammet" }] }),
  loader: ({ serverContext }) => ({
    failure: serverContext?.verify?.failure ?? null,
  }),
  server: {
    handlers: {
      POST: ({ request, context, next }) =>
        handleVerifyPost({ context, next, request }),
    },
  },
  validateSearch: Search,
});
