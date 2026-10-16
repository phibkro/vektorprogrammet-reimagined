import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { ContactTabs, TURNSTILE_SCRIPT } from "@/components/site/contactTabs";
import { getContactPage } from "@/functions/public.functions";
import { validateContactSearch } from "@/lib/contactSearch";
import type { ContactSearch } from "@/lib/contactSearch";
import { pageData } from "@/lib/outcome";
import { handleContactPost } from "@/server/contactPost";

const routeApi = getRouteApi("/kontakt/$department");

const DepartmentContactRoute = () => {
  const { view, formState } = routeApi.useLoaderData();

  return <ContactTabs formState={formState} view={view} />;
};

/** C10 contact form of one department; `?sendt=1` shows the receipt after a post. An unknown department is 404. */
export const Route = createFileRoute("/kontakt/$department")({
  component: DepartmentContactRoute,
  head: () => ({
    scripts: [{ async: true, defer: true, src: TURNSTILE_SCRIPT }],
  }),
  loader: ({ params, deps, serverContext }) =>
    getContactPage({
      data: { sent: deps.sendt === 1, slug: params.department },
    })
      .then(pageData)
      .then((view) => ({
        formState: serverContext?.contactForm ?? null,
        view,
      })),
  loaderDeps: ({ search }: { readonly search: ContactSearch }) => search,
  server: {
    handlers: {
      POST: ({ request, context, next }) =>
        handleContactPost({ context, next, request }),
    },
  },
  validateSearch: validateContactSearch,
});
