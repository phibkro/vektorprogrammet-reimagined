import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { SanitizedHtmlBlock } from "@/components/forms";
import { getStaticPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/foreldre");

const ParentsPage = () => {
  const blocks = routeApi.useLoaderData();

  return (
    <main className="page-wrap grid gap-8 px-4 py-12">
      <SanitizedHtmlBlock html={blocks["parent-header"] ?? null} />
      <SanitizedHtmlBlock html={blocks["parent-assistants-info"] ?? null} />
      <SanitizedHtmlBlock html={blocks["parent-course"] ?? null} />
    </main>
  );
};

/** C4 parents page. */
export const Route = createFileRoute("/foreldre")({
  component: ParentsPage,
  loader: () => getStaticPage({ data: { page: "foreldre" } }).then(pageData),
});
