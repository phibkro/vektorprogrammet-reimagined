import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { getTeamPage } from "../../features/site/server/functions";
import { TeamPage } from "../../features/teams/components/teamPage";
import { pageData } from "../../http/outcome";

const routeApi = getRouteApi("/team/");

/** Team: the departments and the teams of the first one. */
export const Route = createFileRoute("/team/")({
  component: () => <TeamPage view={routeApi.useLoaderData()} />,
  head: () => ({ meta: [{ title: "Team – Vektorprogrammet" }] }),
  loader: () => getTeamPage({ data: { slug: null } }).then(pageData),
});
