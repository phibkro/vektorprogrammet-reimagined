import { Link } from "@tanstack/react-router";
import { SanitizedHtmlBlock } from "@/components/forms";
import type { NewsPageView } from "@/server/pages";

/** `?page=N` (N ≥ 2); page 1 is the bare URL, so `/nyheter` is not redirected (RULE-326 pages are 1-based). */
export const validateNewsSearch = (search: Record<string, unknown>): { page?: number } => {
  const page = Number(search.page);
  return Number.isInteger(page) && page >= 2 ? { page } : {};
};

/** C5 news list with department filter and pagination (RULE-326: 10 per page). */
export function NewsList({ view }: { view: NewsPageView }) {
  const pageLink = (page: number) =>
    view.department === null
      ? ({ to: "/nyheter", search: page === 1 ? {} : { page } } as const)
      : ({
          to: "/nyheter/$department",
          params: { department: view.department.shortName },
          search: page === 1 ? {} : { page },
        } as const);
  return (
    <main className="page-wrap grid gap-6 px-4 py-12">
      <h1 className="text-3xl font-bold">
        Nyheter{view.department === null ? "" : ` – ${view.department.name}`}
      </h1>
      <nav aria-label="Avdelinger" className="flex flex-wrap gap-3 text-sm">
        <Link to="/nyheter" search={{}}>
          Alle
        </Link>
        {view.departments.map((department) => (
          <Link
            key={department.id}
            to="/nyheter/$department"
            params={{ department: department.shortName }}
            search={{}}
          >
            {department.shortName}
          </Link>
        ))}
      </nav>
      {view.items.length === 0 ? (
        <p>Ingen nyheter her.</p>
      ) : (
        <ul className="grid gap-4">
          {view.items.map((article) => (
            <li key={article.slug} className="island-shell rounded-xl p-4">
              <Link to="/nyhet/$slug" params={{ slug: article.slug }} className="font-semibold">
                {article.title}
              </Link>
              <p className="m-0 text-sm text-[var(--sea-ink-soft)]">{article.date}</p>
            </li>
          ))}
        </ul>
      )}
      {view.totalPages > 1 && (
        <nav aria-label="Sider" className="flex gap-3">
          {Array.from({ length: view.totalPages }, (_, index) => index + 1).map((page) => (
            <Link
              key={page}
              {...pageLink(page)}
              aria-current={page === view.page ? "page" : undefined}
              className={page === view.page ? "font-bold" : undefined}
            >
              {page}
            </Link>
          ))}
        </nav>
      )}
      <SanitizedHtmlBlock html={view.blocks["vektor_i_media"] ?? null} />
    </main>
  );
}
