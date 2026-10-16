import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { ContactPage, TURNSTILE_SCRIPT } from "@/components/contactPage";
import { getContactPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";
import { handleContactPost } from "@/server/contactPost";

interface ContactSearch {
  readonly sendt?: unknown;
}

const validateContactSearch = (
  search: ContactSearch
): { readonly sendt?: 1 } =>
  search.sendt === 1 || search.sendt === "1" ? { sendt: 1 } : {};

type ContactRouteSearch = ReturnType<typeof validateContactSearch>;

const routeApi = getRouteApi("/kontakt/avdeling/$id");

const DepartmentContactRoute = () => {
  const { view, departmentId, formState } = routeApi.useLoaderData();

  return (
    <ContactPage
      view={view}
      departmentId={departmentId}
      formState={formState}
    />
  );
};

/** C10 contact form with the department preselected; the sent=1 query shows the receipt after a post. */
export const Route = createFileRoute("/kontakt/avdeling/$id")({
  component: DepartmentContactRoute,
  head: () => ({
    scripts: [{ async: true, defer: true, src: TURNSTILE_SCRIPT }],
  }),
  loader: ({ params, deps, serverContext }) => {
    const departmentId = /^\d+$/u.test(params.id) ? Number(params.id) : null;

    return getContactPage({
      data: { sentTo: deps.sendt === 1 ? departmentId : null },
    })
      .then(pageData)
      .then((view) => ({
        departmentId,
        formState: serverContext?.contactForm ?? null,
        view,
      }));
  },
  loaderDeps: ({ search }: { readonly search: ContactRouteSearch }) => ({
    sendt: search.sendt,
  }),
  server: {
    handlers: {
      POST: ({ request, context, next }) =>
        handleContactPost({ context, next, request }),
    },
  },
  validateSearch: validateContactSearch,
});
