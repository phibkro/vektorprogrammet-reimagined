import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Schema } from "effect";

import { CodeForm } from "@/components/auth/codeForm";

const Search = Schema.toStandardSchemaV1(
  Schema.Struct({ kode: Schema.optionalKey(Schema.String) })
);

const routeApi = getRouteApi("/tilbakestill-passord");

const ResetPage = () => (
  <CodeForm code={routeApi.useSearch().kode} purpose="reset" />
);

export const Route = createFileRoute("/tilbakestill-passord")({
  component: ResetPage,
  validateSearch: Search,
});
