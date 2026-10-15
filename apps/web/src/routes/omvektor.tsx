import { createFileRoute } from "@tanstack/react-router";
import { SanitizedHtmlBlock } from "@/components/forms";
import { getStaticPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

/** C4 about page; `/om`, `/bedrifter` and `/faq` answer 301 here (`server/redirects.ts`). */
export const Route = createFileRoute("/omvektor")({
  loader: () => getStaticPage({ data: { page: "omvektor" } }).then(pageData),
  component: AboutPage,
});

function AboutPage() {
  const blocks = Route.useLoaderData();
  return (
    <main className="page-wrap grid gap-8 px-4 py-12">
      <SanitizedHtmlBlock html={blocks["about-header"] ?? null} />
      <SanitizedHtmlBlock html={blocks["about-motivate-children"] ?? null} />
      <SanitizedHtmlBlock html={blocks["about-motivate-students"] ?? null} />
      <SanitizedHtmlBlock html={blocks["about-try-teaching"] ?? null} />
      <section className="island-shell rounded-2xl p-6">
        <SanitizedHtmlBlock html={blocks["about-faq"] ?? null} />
        <p>
          Noe du lurer på? <a href="/kontakt">Ta kontakt med oss!</a>
        </p>
      </section>
    </main>
  );
}
