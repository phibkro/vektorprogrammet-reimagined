import { Outlet, createFileRoute, getRouteApi } from "@tanstack/react-router";

import { NotSignedIn } from "@/components/panel/notSignedIn";
import { PanelShell } from "@/components/panel/panelShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getShell } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel");

const PanelNotFound = () => (
  <Alert>
    <AlertTitle>Fant ikke siden</AlertTitle>
    <AlertDescription>Siden finnes ikke i kontrollpanelet.</AlertDescription>
  </Alert>
);

const ControlPanelLayout = () => {
  const { actor, navigation, testActors } = routeApi.useLoaderData();

  if (actor === null) {
    return <NotSignedIn testActors={testActors} />;
  }

  return (
    <PanelShell actor={actor} navigation={navigation}>
      <Outlet />
    </PanelShell>
  );
};

/**
 * Staff control panel: a dashboard shell (sidebar, header, page) that owns the whole page. The sidebar lists
 * only the sections the actor may use, derived from the domain's capabilities (`server/shell.ts`); a visitor who
 * is not signed in gets a plain page instead. Phase 1 has no login: authority is decided inside each command's
 * transaction (deny by default), so outside a local deployment every write here is refused with 403, whatever
 * the shell shows.
 */
export const Route = createFileRoute("/kontrollpanel")({
  component: ControlPanelLayout,
  loader: () => getShell().then(pageData),
  notFoundComponent: PanelNotFound,
  staticData: { ownsPage: true },
});
