import { createFileRoute } from "@tanstack/react-router";
import { SanitizedHtmlBlock } from "@/components/forms";
import { getArticlePage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

/** C5 article page. A draft or unknown slug is 404 (RULE-267); `/artikkel/{slug}` answers 301 here. */
export const Route = createFileRoute("/nyhet/$slug")({
  loader: ({ params }) => getArticlePage({ data: { slug: params.slug } }).then(pageData),
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.title} – Vektorprogrammet` }] : [],
  }),
  component: ArticlePage,
});

function ArticlePage() {
  const article = Route.useLoaderData();
  return (
    <main className="page-wrap grid gap-6 px-4 py-12">
      <article className="grid gap-4">
        <h1 className="text-3xl font-bold">{article.title}</h1>
        <p className="m-0 text-sm text-[var(--sea-ink-soft)]">{article.date}</p>
        <img
          src={`/filer/${article.imageLargeKey}`}
          alt=""
          className="max-h-96 w-full rounded-xl object-cover"
        />
        <SanitizedHtmlBlock html={article.bodyHtml} />
      </article>
    </main>
  );
}
