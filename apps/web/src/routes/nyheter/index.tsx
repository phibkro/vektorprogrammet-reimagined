import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { NewsList } from "@/components/site/newsParts";
import { PortableTextView } from "@/components/site/portableTextView";
import { getNewsPage } from "@/functions/public.functions";
import { validateNewsSearch } from "@/lib/newsSearch";
import type { NewsSearch } from "@/lib/newsSearch";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/nyheter/");

const NewsPage = () => {
  const view = routeApi.useLoaderData();

  return (
    <main className="mx-auto flex w-full max-w-4xl grow flex-col gap-8 px-6 py-16">
      <h1 className="text-3xl font-bold">Nyheter</h1>
      <NewsList view={view} />
      <PortableTextView value={view.texts.vektor_i_media ?? null} />
    </main>
  );
};

/** Nyheter: the published articles, ten per page, newest first (RULE-326), for a department or all. */
export const Route = createFileRoute("/nyheter/")({
  component: NewsPage,
  head: () => ({ meta: [{ title: "Nyheter – Vektorprogrammet" }] }),
  loader: ({ deps }) =>
    getNewsPage({
      data: { department: deps.avdeling ?? null, page: deps.side ?? 1 },
    }).then(pageData),
  loaderDeps: ({ search }: { readonly search: NewsSearch }) => search,
  validateSearch: validateNewsSearch,
});
