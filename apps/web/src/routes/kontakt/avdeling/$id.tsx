import { createFileRoute } from "@tanstack/react-router";
import { ContactPage, TURNSTILE_SCRIPT } from "@/components/ContactPage";
import { getContactPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";
import { handleContactPost } from "@/server/contactPost";

/** C10 contact form with the department preselected; `?sendt=1` shows the receipt after a post. */
export const Route = createFileRoute("/kontakt/avdeling/$id")({
  validateSearch: (search: Record<string, unknown>): { sendt?: 1 } =>
    search.sendt === 1 || search.sendt === "1" ? { sendt: 1 } : {},
  server: {
    handlers: {
      POST: ({ request, context, next }) => handleContactPost({ request, context, next }),
    },
  },
  head: () => ({ scripts: [{ src: TURNSTILE_SCRIPT, async: true, defer: true }] }),
  loaderDeps: ({ search }) => ({ sent: search.sendt === 1 }),
  loader: ({ params, deps, serverContext }) => {
    const departmentId = /^\d+$/.test(params.id) ? Number(params.id) : null;
    return getContactPage({ data: { sentTo: deps.sent ? departmentId : null } })
      .then(pageData)
      .then((view) => ({ view, departmentId, formState: serverContext?.contactForm ?? null }));
  },
  component: DepartmentContactRoute,
});

function DepartmentContactRoute() {
  const { view, departmentId, formState } = Route.useLoaderData();
  return <ContactPage view={view} departmentId={departmentId} formState={formState} />;
}
