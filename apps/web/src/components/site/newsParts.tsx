/**
 * News on the public pages: the front page teaser, the list with its department filter and ten-per-page
 * pagination (RULE-326), and the card they share. Ported from mono-web's `NewsTeaser` and `nyheter` route
 * (`apps/homepage/src`, commit 2aa6ce97); the articles come from the CMS (`news`). Mono-web showed an author's
 * name; EmDash authors are CMS users and are not shown.
 */
import { Link } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { departmentLinkClass } from "@/components/site/pageParts";
import type { NewsCardView, NewsPageView } from "@/server/site/pages";

const NewsLink = ({ article }: { readonly article: NewsCardView }) => (
  <li className="flex items-start gap-4">
    {article.image !== null && (
      <img
        alt={article.image.alt}
        className="size-16 shrink-0 rounded object-cover"
        src={article.image.src}
      />
    )}
    <div className="flex flex-col gap-1">
      <Link
        className="text-lg font-semibold hover:underline"
        params={{ slug: article.slug }}
        to="/nyhet/$slug"
      >
        {article.sticky ? "★ " : ""}
        {article.title}
      </Link>
      <p className="text-vektor-muted text-sm">{article.date}</p>
    </div>
  </li>
);

export const NewsTeaser = ({
  articles,
}: {
  readonly articles: readonly NewsCardView[];
}) =>
  articles.length === 0 ? null : (
    <section
      aria-labelledby="news-teaser-heading"
      className="mx-auto w-full max-w-4xl px-6 pb-8"
    >
      <h2 className="mb-6 text-2xl font-bold" id="news-teaser-heading">
        Nyheter
      </h2>
      <ul className="flex flex-col gap-4">
        {Arr.map(articles, (article) => (
          <NewsLink article={article} key={article.slug} />
        ))}
      </ul>
      <Link
        className="mt-6 inline-block font-semibold hover:underline"
        search={{}}
        to="/nyheter"
      >
        Se alle nyheter
      </Link>
    </section>
  );

export const NewsList = ({ view }: { readonly view: NewsPageView }) => {
  const {
    department,
    departments,
    items,
    page,
    totalPages,
    unknownDepartment,
  } = view;

  const avdeling = department?.slug;

  return (
    <div className="flex flex-col gap-8">
      <nav aria-label="Velg avdeling" className="flex flex-wrap gap-2">
        <Link
          aria-current={department === null ? "page" : undefined}
          className={departmentLinkClass(department === null)}
          search={{}}
          to="/nyheter"
        >
          Alle
        </Link>
        {Arr.map(departments, (candidate) => (
          <Link
            aria-current={candidate.id === department?.id ? "page" : undefined}
            className={departmentLinkClass(candidate.id === department?.id)}
            key={candidate.id}
            search={{ avdeling: candidate.slug }}
            to="/nyheter"
          >
            {candidate.shortName}
          </Link>
        ))}
      </nav>
      {unknownDepartment && (
        <p
          className="border-vektor-notice-line bg-vektor-notice rounded border p-4 text-sm"
          role="status"
        >
          Avdelingen du valgte finnes ikke lenger. Viser alle nyheter.
        </p>
      )}
      {items.length === 0 ? (
        <p role="status">Ingen nyheter å vise.</p>
      ) : (
        <ul className="flex flex-col gap-6">
          {Arr.map(items, (article) => (
            <NewsLink article={article} key={article.slug} />
          ))}
        </ul>
      )}
      {totalPages > 1 && (
        <nav aria-label="Sider" className="flex items-center justify-between">
          {page > 1 ? (
            <Link
              className="font-semibold hover:underline"
              search={{ avdeling, side: page - 1 }}
              to="/nyheter"
            >
              Forrige
            </Link>
          ) : (
            <span />
          )}
          <span>
            Side {page} av {totalPages}
          </span>
          {page < totalPages ? (
            <Link
              className="font-semibold hover:underline"
              search={{ avdeling, side: page + 1 }}
              to="/nyheter"
            >
              Neste
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
};
