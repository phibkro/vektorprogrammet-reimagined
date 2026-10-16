import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { NewsList, validateNewsSearch } from "@/components/newsList";
import type { PageSearch } from "@/components/newsList";
import { getNewsPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

/** C5 articles tagged with the department (by short name) or untagged; unknown department → 404. */
const routeApi = getRouteApi("/nyheter/$department");

export const Route = createFileRoute("/nyheter/$department")({
  component: () => <NewsList view={routeApi.useLoaderData()} />,
  loader: ({ deps, params }) =>
    getNewsPage({
      data: { department: params.department, page: deps.page ?? 1 },
    }).then(pageData),
  loaderDeps: ({ search }: { readonly search: PageSearch }) => ({
    page: search.page,
  }),
  validateSearch: validateNewsSearch,
});
