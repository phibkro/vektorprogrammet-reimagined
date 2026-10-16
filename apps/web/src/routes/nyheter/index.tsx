import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { NewsList, validateNewsSearch } from "@/components/newsList";
import type { PageSearch } from "@/components/newsList";
import { getNewsPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

/** C5 published articles, 10 per page (RULE-326). */
const routeApi = getRouteApi("/nyheter/");

export const Route = createFileRoute("/nyheter/")({
  component: () => <NewsList view={routeApi.useLoaderData()} />,
  loader: ({ deps }) =>
    getNewsPage({ data: { department: null, page: deps.page ?? 1 } }).then(
      pageData
    ),
  loaderDeps: ({ search }: { readonly search: PageSearch }) => ({
    page: search.page,
  }),
  validateSearch: validateNewsSearch,
});
