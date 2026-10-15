import { createFileRoute } from "@tanstack/react-router";
import { NewsList, validateNewsSearch } from "@/components/NewsList";
import { getNewsPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

/** C5 articles tagged with the department (by short name) or untagged; unknown department → 404. */
export const Route = createFileRoute("/nyheter/$department")({
  validateSearch: validateNewsSearch,
  loaderDeps: ({ search }) => ({ page: search.page ?? 1 }),
  loader: ({ deps, params }) =>
    getNewsPage({ data: { page: deps.page, department: params.department } }).then(pageData),
  component: () => <NewsList view={Route.useLoaderData()} />,
});
