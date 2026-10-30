import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { ApplicationPageView } from "@/components/site/applicationPage";
import { getApplicationPage } from "@/functions/public.functions";
import { validateContactSearch } from "@/lib/contactSearch";
import type { ContactSearch } from "@/lib/contactSearch";
import { pageData } from "@/lib/outcome";
import { handleApplicationPost } from "@/server/admissionPost";

const routeApi = getRouteApi("/soknad/$department");

const ApplicationRoute = () => {
  const { formState, view } = routeApi.useLoaderData();

  return (
    <ApplicationPageView
      formState={formState}
      turnstileSiteKey={view.turnstileSiteKey}
      view={view}
    />
  );
};

/** Spec 0009: the application form of one department; `?sendt=1` shows the receipt after a post. An unknown department is 404. */
export const Route = createFileRoute("/soknad/$department")({
  component: ApplicationRoute,
  head: () => ({ meta: [{ title: "Søk – Vektorprogrammet" }] }),
  loader: ({ params, deps, serverContext }) =>
    getApplicationPage({
      data: { sent: deps.sendt === 1, slug: params.department },
    })
      .then(pageData)
      .then((view) => ({
        formState: serverContext?.applicationForm ?? null,
        view,
      })),
  loaderDeps: ({ search }: { readonly search: ContactSearch }) => search,
  server: {
    handlers: {
      POST: ({ request, context, next }) =>
        handleApplicationPost({ context, next, request }),
    },
  },
  validateSearch: validateContactSearch,
});
