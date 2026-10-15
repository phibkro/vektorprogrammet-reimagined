import { createFileRoute } from "@tanstack/react-router";
import { SanitizedHtmlBlock } from "@/components/forms";
import { getStaticPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

/** C4 parents page. */
export const Route = createFileRoute("/foreldre")({
  loader: () => getStaticPage({ data: { page: "foreldre" } }).then(pageData),
  component: ParentsPage,
});

function ParentsPage() {
  const blocks = Route.useLoaderData();
  return (
    <main className="page-wrap grid gap-8 px-4 py-12">
      <SanitizedHtmlBlock html={blocks["parent-header"] ?? null} />
      <SanitizedHtmlBlock html={blocks["parent-assistants-info"] ?? null} />
      <SanitizedHtmlBlock html={blocks["parent-course"] ?? null} />
    </main>
  );
}
