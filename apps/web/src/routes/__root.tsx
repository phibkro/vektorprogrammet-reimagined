import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import Footer from "@/components/Footer";
import Header from "@/components/Header";
import { getFooter } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Vektorprogrammet" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  loader: () => getFooter().then(pageData),
  component: RootComponent,
  notFoundComponent: NotFoundPage,
  errorComponent: ({ error }) => (
    <main className="page-wrap px-4 py-12">
      <h1 className="text-2xl font-bold">Noe gikk galt</h1>
      <p>{error instanceof Error ? error.message : "Ukjent feil."}</p>
    </main>
  ),
  shellComponent: RootDocument,
});

function RootComponent() {
  const sponsors = Route.useLoaderData();
  return (
    <>
      <Header />
      <Outlet />
      <Footer sponsors={sponsors} />
    </>
  );
}

function NotFoundPage() {
  return (
    <main className="page-wrap px-4 py-12">
      <h1 className="text-2xl font-bold">Fant ikke siden</h1>
      <p>
        Siden finnes ikke, eller er ikke publisert. <Link to="/">Til forsiden</Link>
      </p>
    </main>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="nb">
      <head>
        <HeadContent />
      </head>
      <body className="font-sans antialiased [overflow-wrap:anywhere]">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
