import { Link, createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { Divider, greenButtonClass } from "@/components/site/pageParts";
import { PortableTextView } from "@/components/site/portableTextView";
import { getSchoolsPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/skoler");

const SchoolsPage = () => {
  const { departments, texts } = routeApi.useLoaderData();

  return (
    <main>
      <div className="mx-5 mt-20 flex flex-col items-center justify-center gap-3 leading-relaxed md:gap-5">
        <div className="flex max-w-3xl flex-col gap-3 md:gap-5">
          <PortableTextView value={texts["schools-header"] ?? null} />
          <Divider />
          <PortableTextView value={texts["schools-about"] ?? null} />
          <img
            alt="Lærer"
            className="mx-auto w-1/2 flex-wrap items-center justify-center gap-5 md:flex-nowrap md:justify-between md:gap-14"
            src="/images/teacher2.png"
          />
          <PortableTextView value={texts["schools-more"] ?? null} />
        </div>
      </div>
      <div className="info-background mx-auto mb-20 flex flex-col items-center gap-5 p-5 py-48 md:gap-5">
        <PortableTextView
          className="max-w-3xl md:max-w-2xl"
          tone="dark"
          value={texts["schools-tips"] ?? null}
        />
      </div>
      <section className="mx-auto mt-40 mb-20 flex max-w-80 flex-col items-center gap-10 p-5 md:max-w-none">
        <PortableTextView
          className="max-w-3xl"
          value={texts["schools-apply"] ?? null}
        />
        <nav aria-label="Velg avdeling" className="flex flex-col md:flex-row">
          {Arr.map(departments, (department) => (
            <Link
              className={`${greenButtonClass} my-2 min-w-48 md:mx-6`}
              key={department.id}
              params={{ department: department.slug }}
              to="/kontakt/$department"
            >
              {department.city}
            </Link>
          ))}
        </nav>
        <PortableTextView
          className="max-w-3xl md:text-center"
          value={texts["schools-missing-city"] ?? null}
        />
      </section>
    </main>
  );
};

/** Skoler: the CMS texts, and a way to each department's contact page (the school coordinator). */
export const Route = createFileRoute("/skoler")({
  component: SchoolsPage,
  head: () => ({ meta: [{ title: "For skoler – Vektorprogrammet" }] }),
  loader: () => getSchoolsPage().then(pageData),
});
