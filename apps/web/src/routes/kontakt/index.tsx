import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { ContactPage, TURNSTILE_SCRIPT } from "@/components/contactPage";
import { getContactPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";
import { handleContactPost } from "@/server/contactPost";

const routeApi = getRouteApi("/kontakt/");

const ContactRoute = () => {
  const { view, formState } = routeApi.useLoaderData();

  return <ContactPage view={view} departmentId={null} formState={formState} />;
};

/** C10 contact form (RULE-156, 167, 249); the visitor picks the department (RULE-327 replacement). */
export const Route = createFileRoute("/kontakt/")({
  component: ContactRoute,
  head: () => ({
    scripts: [{ async: true, defer: true, src: TURNSTILE_SCRIPT }],
  }),
  loader: ({ serverContext }) =>
    getContactPage({ data: { sentTo: null } })
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
