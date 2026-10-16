import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { TeamPage } from "@/components/site/teamPage";
import { getTeamPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/team/$department");

/** Team of one department; an unknown department is 404. */
export const Route = createFileRoute("/team/$department")({
  component: () => <TeamPage view={routeApi.useLoaderData()} />,
  head: () => ({ meta: [{ title: "Team – Vektorprogrammet" }] }),
  loader: ({ params }) =>
    getTeamPage({ data: { slug: params.department } }).then(pageData),
});
