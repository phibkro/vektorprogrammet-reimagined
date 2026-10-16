import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { TeamPage } from "@/components/site/teamPage";
import { getTeamPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/team/");

/** Team: the departments and the teams of the first one. */
export const Route = createFileRoute("/team/")({
  component: () => <TeamPage view={routeApi.useLoaderData()} />,
  head: () => ({ meta: [{ title: "Team – Vektorprogrammet" }] }),
  loader: () => getTeamPage({ data: { slug: null } }).then(pageData),
});
