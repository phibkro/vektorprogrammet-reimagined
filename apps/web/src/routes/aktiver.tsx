import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Schema } from "effect";

import { CodeForm } from "@/components/auth/codeForm";

const Search = Schema.toStandardSchemaV1(
  Schema.Struct({ kode: Schema.optionalKey(Schema.String) })
);

const routeApi = getRouteApi("/aktiver");

const ActivatePage = () => (
  <CodeForm code={routeApi.useSearch().kode} purpose="activation" />
);

export const Route = createFileRoute("/aktiver")({
  component: ActivatePage,
  validateSearch: Search,
});
