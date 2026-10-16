import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { PageHeader } from "@/components/panel/pageHeader";
import { TestActorSwitch } from "@/components/panel/testActorSwitch";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getDashboard } from "@/functions/panel.functions";
import { actorLabel } from "@/lib/actorLabel";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/");

const shellApi = getRouteApi("/kontrollpanel");

const Dashboard = () => {
  const { actor, currentSemester } = routeApi.useLoaderData();
  const { testActors } = shellApi.useLoaderData();

  return (
    <>
      <PageHeader
        title="Kontrollpanel"
        description="Sidemenyen viser bare det du har tilgang til."
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>Nåværende semester</CardDescription>
            <CardTitle>{currentSemester}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Innlogget som</CardDescription>
            <CardTitle>
              {actor === null ? "Anonym" : actorLabel(actor)}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>
      {testActors && <TestActorSwitch />}
    </>
  );
};

/** C2: the current semester (RULE-033; created when missing, RULE-237) and who is acting. */
export const Route = createFileRoute("/kontrollpanel/")({
  component: Dashboard,
  loader: () => getDashboard().then(pageData),
});
