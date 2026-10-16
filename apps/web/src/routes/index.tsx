import { Link, createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { SanitizedHtmlBlock } from "@/components/forms";
import { getHomePage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/");

const HomePage = () => {
  const { departments, news, blocks } = routeApi.useLoaderData();

  return (
    <main className="page-wrap grid gap-10 px-4 pt-12 pb-8">
      <section className="island-shell rounded-2xl p-6 sm:p-10">
        <h1 className="display-title text-sea-ink mb-4 text-4xl font-bold">
          Vektorprogrammet
        </h1>
        <SanitizedHtmlBlock html={blocks["home-tagline"] ?? null} />
      </section>
      <section aria-labelledby="avdelinger">
        <h2 id="avdelinger" className="mb-3 text-xl font-semibold">
          Avdelinger
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Arr.map(departments, (department) => (
            <li key={department.id} className="island-shell rounded-xl p-4">
              <p className="m-0 font-semibold">{department.name}</p>
              <p className="text-sea-ink-soft m-0 text-sm">{department.city}</p>
              <Link
                to="/kontakt/avdeling/$id"
                params={{ id: String(department.id) }}
                className="text-sm"
              >
                Kontakt {department.shortName}
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="nyheter">
        <h2 id="nyheter" className="mb-3 text-xl font-semibold">
          Nyheter
        </h2>
        {news.length === 0 ? (
          <p>Ingen nyheter den siste tiden.</p>
        ) : (
          <ul className="grid gap-3">
            {Arr.map(news, (article) => (
              <li key={article.slug}>
                <Link
                  to="/nyhet/$slug"
                  params={{ slug: article.slug }}
                  className="font-semibold"
                >
                  {article.title}
                </Link>{" "}
                <span className="text-sea-ink-soft text-sm">
                  {article.date}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link to="/nyheter" search={{}} className="mt-3 inline-block text-sm">
          Alle nyheter
        </Link>
      </section>
    </main>
  );
};

/** C3 home: departments, recent or sticky news (RULE-331), real counts only (RULE-075 offsets dropped). */
export const Route = createFileRoute("/")({
  component: HomePage,
  loader: () => getHomePage().then(pageData),
});
