import { Link, createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { PortableTextView } from "@/components/site/portableTextView";
import { getArticlePage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";
import type { ArticleView } from "@/server/site/pages";

const routeApi = getRouteApi("/nyhet/$slug");

/** TanStack types `loaderData` as optional in `head`; an annotation of the loader's result keeps the route typed. */
const articleHead = ({
  loaderData,
}: {
  readonly loaderData?: ArticleView;
}) => ({
  meta:
    loaderData === undefined
      ? []
      : [{ title: `${loaderData.title} – Vektorprogrammet` }],
});

const ArticlePage = () => {
  const article = routeApi.useLoaderData();

  return (
    <main className="mx-auto grid w-full max-w-5xl grow gap-10 px-6 py-16 md:grid-cols-[minmax(0,1fr)_16rem]">
      <article className="flex min-w-0 flex-col gap-4">
        <h1 className="text-3xl font-bold">{article.title}</h1>
        <p className="text-vektor-muted text-sm">{article.date}</p>
        {article.image !== null && (
          <img
            alt={article.image.alt}
            className="max-h-96 w-full rounded-xl object-cover"
            src={article.image.src}
          />
        )}
        <PortableTextView value={article.content} />
      </article>
      <aside aria-labelledby="other-news-heading">
        <h2 className="text-sm font-semibold uppercase" id="other-news-heading">
          Andre nyheter
        </h2>
        {article.others.length === 0 ? (
          <p className="text-vektor-muted mt-2 text-sm">Ingen andre nyheter.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-3">
            {Arr.map(article.others, (other) => (
              <li key={other.slug}>
                <Link
                  className="text-sm hover:underline"
                  params={{ slug: other.slug }}
                  to="/nyhet/$slug"
                >
                  {other.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </main>
  );
};

/** Nyhet: one article. A draft or unknown slug is 404 (RULE-267); `/artikkel/{slug}` answers 301 here. */
export const Route = createFileRoute("/nyhet/$slug")({
  component: ArticlePage,
  head: articleHead,
  loader: ({ params }) =>
    getArticlePage({ data: { slug: params.slug } }).then(pageData),
});
