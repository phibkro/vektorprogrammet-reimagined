import { Outlet, createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { NoSections, NotSignedIn } from "@/components/panel/notSignedIn";
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
  const { actor, navigation } = routeApi.useLoaderData();

  if (actor === null) {
    return <NotSignedIn />;
  }

  if (Arr.isReadonlyArrayEmpty(navigation)) {
    return <NoSections name={actor.name} />;
  }

  return (
    <PanelShell actor={actor} navigation={navigation}>
      <Outlet />
    </PanelShell>
  );
};

/**
 * The control panel: a dashboard shell (sidebar, header, page) that owns the whole page. The sidebar lists only the
 * sections the principal may use, derived from the grant table (`server/shell.ts`: `canAnywhere`); a visitor who is
 * not signed in gets a plain page instead, and so does a person who belongs to no team.
 * Each command independently checks the current principal and grants.
 */
export const Route = createFileRoute("/kontrollpanel")({
  component: ControlPanelLayout,
  loader: () => getShell().then(pageData),
  notFoundComponent: PanelNotFound,
  staticData: { ownsPage: true },
});
