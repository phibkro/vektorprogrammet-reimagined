import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { Divider, TextPictureParagraph } from "@/components/site/pageParts";
import { PortableTextView } from "@/components/site/portableTextView";
import { getParentsPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/foreldre");

const ParentsPage = () => {
  const { texts } = routeApi.useLoaderData();

  return (
    <main className="mt-20 mb-20 flex max-w-4xl flex-col items-center gap-10 self-center p-5 md:gap-28">
      <div className="flex max-w-full flex-col gap-3 md:gap-5">
        <PortableTextView value={texts["parent-header"] ?? null} />
        <Divider />
      </div>
      <TextPictureParagraph
        alt="Vektor samlet"
        pictureOnLeft
        src="/images/teacher2.png"
        text={texts["parent-assistants-info"] ?? null}
      />
      <TextPictureParagraph
        alt="Under møte"
        pictureOnLeft={false}
        src="/images/teacher2.png"
        text={texts["parent-course"] ?? null}
      />
    </main>
  );
};

/** Foreldre: three CMS texts around mono-web's pictures. */
export const Route = createFileRoute("/foreldre")({
  component: ParentsPage,
  head: () => ({ meta: [{ title: "For foreldre – Vektorprogrammet" }] }),
  loader: () => getParentsPage().then(pageData),
});
