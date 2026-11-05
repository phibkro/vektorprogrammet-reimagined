import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { ApplyIndex } from "../../features/admission/components/applicationPage";
import { getApplyIndex } from "../../features/site/server/functions";
import { pageData } from "../../http/outcome";

const routeApi = getRouteApi("/soknad/");

const ApplyRoute = () => <ApplyIndex view={routeApi.useLoaderData()} />;

/** Spec 0009: the departments whose admission is open, each with the way to its application form. */
export const Route = createFileRoute("/soknad/")({
  component: ApplyRoute,
  head: () => ({ meta: [{ title: "Søk – Vektorprogrammet" }] }),
  loader: () => getApplyIndex().then(pageData),
});
