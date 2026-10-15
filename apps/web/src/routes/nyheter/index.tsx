import { createFileRoute } from "@tanstack/react-router";
import { NewsList, validateNewsSearch } from "@/components/NewsList";
import { getNewsPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

/** C5 published articles, 10 per page (RULE-326). */
export const Route = createFileRoute("/nyheter/")({
  validateSearch: validateNewsSearch,
  loaderDeps: ({ search }) => ({ page: search.page ?? 1 }),
  loader: ({ deps }) => getNewsPage({ data: { page: deps.page, department: null } }).then(pageData),
  component: () => <NewsList view={Route.useLoaderData()} />,
});
