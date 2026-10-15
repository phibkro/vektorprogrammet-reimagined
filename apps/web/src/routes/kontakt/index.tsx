import { createFileRoute } from "@tanstack/react-router";
import { ContactPage, TURNSTILE_SCRIPT } from "@/components/ContactPage";
import { getContactPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";
import { handleContactPost } from "@/server/contactPost";

/** C10 contact form (RULE-156, 167, 249); the visitor picks the department (RULE-327 replacement). */
export const Route = createFileRoute("/kontakt/")({
  server: {
    handlers: {
      POST: ({ request, context, next }) => handleContactPost({ request, context, next }),
    },
  },
  head: () => ({ scripts: [{ src: TURNSTILE_SCRIPT, async: true, defer: true }] }),
  loader: ({ serverContext }) =>
    getContactPage({ data: { sentTo: null } })
      .then(pageData)
      .then((view) => ({ view, formState: serverContext?.contactForm ?? null })),
  component: ContactRoute,
});

function ContactRoute() {
  const { view, formState } = Route.useLoaderData();
  return <ContactPage view={view} departmentId={null} formState={formState} />;
}
