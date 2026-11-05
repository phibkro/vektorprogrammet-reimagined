import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { getTeamPage } from "../../features/site/server/functions";
import { TeamPage } from "../../features/teams/components/teamPage";
import { pageData } from "../../http/outcome";

const routeApi = getRouteApi("/team/$department");

/** Team of one department; an unknown department is 404. */
export const Route = createFileRoute("/team/$department")({
  component: () => <TeamPage view={routeApi.useLoaderData()} />,
  head: () => ({ meta: [{ title: "Team – Vektorprogrammet" }] }),
  loader: ({ params }) =>
    getTeamPage({ data: { slug: params.department } }).then(pageData),
});
