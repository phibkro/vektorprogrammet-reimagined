import { Link, createFileRoute, getRouteApi } from "@tanstack/react-router";

import { NewsTeaser } from "@/components/site/newsParts";
import { AdmissionStatus, greenButtonClass } from "@/components/site/pageParts";
import { PortableTextView } from "@/components/site/portableTextView";
import { getHomePage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/");

const HomePage = () => {
  const { departments, news, texts } = routeApi.useLoaderData();

  return (
    <main className="grow">
      <div className="border-vektor-blue/40 border-b md:flex md:min-h-[32rem] md:pt-14">
        <div className="flex w-full flex-col items-center text-center md:w-1/2 md:p-8">
          <img
            alt="Vektorprogrammet"
            className="w-2/4 pt-12 pb-14 md:hidden"
            src="/images/vektor-logo.svg"
          />
          <img
            alt=""
            className="mx-auto my-auto h-full w-full max-w-xl p-5 pt-14 md:mr-0 md:ml-auto md:pt-0"
            src="/images/mainPage/vektor-forsidebilde.png"
          />
        </div>
        <div className="w-full p-6 text-center md:mt-24 md:w-1/2 md:p-10 md:text-left">
          <h1 className="mb-4 text-4xl font-bold">Vektorprogrammet</h1>
          <PortableTextView
            className="mb-6 text-left md:w-4/5 md:text-xl"
            value={texts["home-tagline"] ?? null}
          />
          <Link className={greenButtonClass} to="/team">
            Se våre team
          </Link>
        </div>
      </div>
      <div className="info-background flex max-w-full flex-col items-center justify-center py-32 text-center md:mt-20">
        <AdmissionStatus departments={departments} tone="dark" />
      </div>
      <NewsTeaser articles={news} />
    </main>
  );
};

/** Hjem: the tagline, the departments' admission (RULE-119) and the front page news (RULE-331). */
export const Route = createFileRoute("/")({
  component: HomePage,
  loader: () => getHomePage().then(pageData),
});
