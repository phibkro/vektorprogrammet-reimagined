import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  getRouteApi,
  useMatches,
} from "@tanstack/react-router";
import { Array as Arr } from "effect";
import type { ReactNode } from "react";

import { SiteFrame } from "@/components/site/siteFrame";
import { getFooter } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

import appCss from "../styles.css?url";

const routeApi = getRouteApi("__root__");

const RootComponent = () => {
  const sponsors = routeApi.useLoaderData();

  const ownsPage = useMatches({
    select: (matches) =>
      Arr.some(matches, (match) => match.staticData.ownsPage === true),
  });

  if (ownsPage) {
    return <Outlet />;
  }

  return (
    <SiteFrame sponsors={sponsors}>
      <Outlet />
    </SiteFrame>
  );
};

const NotFoundPage = () => (
  <SiteFrame sponsors={[]}>
    <main className="mx-auto w-full max-w-4xl grow px-4 py-12">
      <h1 className="text-2xl font-bold">Fant ikke siden</h1>
      <p>
        Siden finnes ikke, eller er ikke publisert.{" "}
        <Link to="/">Til forsiden</Link>
      </p>
    </main>
  </SiteFrame>
);

const RootDocument = ({ children }: { children: ReactNode }) => (
  <html lang="nb">
    <head>
      <HeadContent />
    </head>
    <body className="font-sans [overflow-wrap:anywhere] antialiased">
      {children}
      <Scripts />
    </body>
  </html>
);

export const Route = createRootRoute({
  component: RootComponent,
  errorComponent: ({ error }) => (
    <SiteFrame sponsors={[]}>
      <main className="mx-auto w-full max-w-4xl grow px-4 py-12">
        <h1 className="text-2xl font-bold">Noe gikk galt</h1>
        <p>{error instanceof Error ? error.message : "Ukjent feil."}</p>
      </main>
    </SiteFrame>
  ),
  head: () => ({
    links: [{ href: appCss, rel: "stylesheet" }],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { title: "Vektorprogrammet" },
    ],
  }),
  loader: () => getFooter().then(pageData),
  notFoundComponent: NotFoundPage,
  shellComponent: RootDocument,
});
