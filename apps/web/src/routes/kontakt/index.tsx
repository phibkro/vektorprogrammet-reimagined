import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { ContactTabs } from "@/components/site/contactTabs";
import { getContactPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";
import { handleContactPost } from "@/server/contactPost";

const routeApi = getRouteApi("/kontakt/");

const ContactRoute = () => {
  const { view, formState } = routeApi.useLoaderData();

  return <ContactTabs formState={formState} view={view} />;
};

/** C10 contact form (RULE-156, 167, 249) with the first department selected; the visitor picks another tab. */
export const Route = createFileRoute("/kontakt/")({
  component: ContactRoute,
  head: () => ({ meta: [{ title: "Kontakt – Vektorprogrammet" }] }),
  loader: ({ serverContext }) =>
    getContactPage({ data: { sent: false, slug: null } })
      .then(pageData)
      .then((view) => ({
        formState: serverContext?.contactForm ?? null,
        view,
      })),
  server: {
    handlers: {
      POST: ({ request, context, next }) =>
        handleContactPost({ context, next, request }),
    },
  },
});
