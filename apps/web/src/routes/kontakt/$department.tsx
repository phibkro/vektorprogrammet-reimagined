import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { ContactTabs } from "../../features/contact/components/contactTabs";
import { validateContactSearch } from "../../features/contact/contactSearch";
import type { ContactSearch } from "../../features/contact/contactSearch";
import { handleContactPost } from "../../features/contact/server/contactPost";
import { getContactPage } from "../../features/site/server/functions";
import { pageData } from "../../http/outcome";

const routeApi = getRouteApi("/kontakt/$department");

const DepartmentContactRoute = () => {
  const { view, formState } = routeApi.useLoaderData();

  return <ContactTabs formState={formState} view={view} />;
};

/** C10 contact form of one department; `?sendt=1` shows the receipt after a post. An unknown department is 404. */
export const Route = createFileRoute("/kontakt/$department")({
  component: DepartmentContactRoute,
  head: () => ({ meta: [{ title: "Kontakt – Vektorprogrammet" }] }),
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
