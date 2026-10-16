import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { Divider, TextPictureParagraph } from "@/components/site/pageParts";
import { PortableTextView } from "@/components/site/portableTextView";
import { getAboutPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/om-oss");

const AboutPage = () => {
  const { texts } = routeApi.useLoaderData();

  return (
    <main className="mt-20 mb-20 flex max-w-4xl flex-col items-center gap-10 self-center p-5 md:gap-28">
      <div className="flex max-w-full flex-col gap-3 md:gap-5">
        <PortableTextView value={texts["about-header"] ?? null} />
        <Divider />
      </div>
      <TextPictureParagraph
        alt="Kosing med Tor."
        pictureOnLeft
        src="/images/teacher2.png"
        text={texts["about-motivate-children"] ?? null}
      />
      <TextPictureParagraph
        alt="Samlede vektormedlemmer."
        pictureOnLeft={false}
        src="/images/teacher2.png"
        text={texts["about-motivate-students"] ?? null}
      />
      <div className="flex w-full flex-col gap-3 md:gap-5">
        <PortableTextView value={texts["about-try-teaching"] ?? null} />
        <img alt="" className="mt-0" src="/images/teacher2.png" />
        <Divider />
      </div>
      <PortableTextView value={texts["about-faq"] ?? null} />
    </main>
  );
};

/** Om oss: five CMS texts around mono-web's pictures. `/om`, `/bedrifter`, `/faq` and `/omvektor` answer 301 here. */
export const Route = createFileRoute("/om-oss")({
  component: AboutPage,
  head: () => ({ meta: [{ title: "Om oss – Vektorprogrammet" }] }),
  loader: () => getAboutPage().then(pageData),
});
