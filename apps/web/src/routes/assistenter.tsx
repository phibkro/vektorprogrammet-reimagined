import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import {
  AdmissionStatus,
  Divider,
  FaqSection,
} from "@/components/site/pageParts";
import { PortableTextView } from "@/components/site/portableTextView";
import { getAssistantsPage } from "@/functions/public.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/assistenter");

const CARDS = [
  "assistants-card-role-model",
  "assistants-card-social",
  "assistants-card-cv",
] as const;

const AssistantsPage = () => {
  const { departments, faq, texts } = routeApi.useLoaderData();

  return (
    <main className="mt-20 mb-20 flex w-full flex-col items-center gap-10 self-center pt-5 pb-5 leading-relaxed">
      <div className="flex max-w-full flex-col gap-3 md:gap-5">
        <PortableTextView
          className="p-5"
          value={texts["assistants-header"] ?? null}
        />
        <AdmissionStatus className="w-full p-10" departments={departments} />
      </div>
      <div className="info-background mb-0 flex w-full max-w-full flex-col flex-wrap items-center justify-center gap-12 py-72 text-center md:mt-20">
        <PortableTextView
          className="w-fit"
          tone="dark"
          value={texts["assistants-why"] ?? null}
        />
        <div className="flex w-full flex-wrap items-start justify-center gap-10 px-5 text-center md:flex-row">
          {Arr.map(CARDS, (slot) => (
            <div
              className="flex w-full max-w-xs flex-col gap-5 md:w-1/3"
              key={slot}
            >
              <img
                alt=""
                className="mx-auto mt-6 mb-2 h-24 rounded-lg"
                src="/images/teacher2.png"
              />
              <PortableTextView tone="dark" value={texts[slot] ?? null} />
            </div>
          ))}
        </div>
      </div>
      <div className="mb-16 flex max-w-3xl flex-col items-center p-5">
        <PortableTextView value={texts["assistants-about"] ?? null} />
        <img
          alt="Vektorassistenter"
          className="mx-auto mt-6 h-80 rounded-lg"
          src="/images/teacher2.png"
        />
      </div>
      <Divider />
      <div className="mb-16 flex max-w-3xl flex-col items-center p-5">
        <PortableTextView value={texts["assistants-tasks"] ?? null} />
      </div>
      <Divider />
      <div className="mx-auto w-4/5">
        <PortableTextView value={texts["assistants-how"] ?? null} />
        <div className="flex flex-col space-y-8 md:flex-row md:space-y-0 md:space-x-16">
          <PortableTextView
            className="flex-1"
            value={texts["assistants-requirements"] ?? null}
          />
          <PortableTextView
            className="flex-1"
            value={texts["assistants-process"] ?? null}
          />
        </div>
      </div>
      <Divider />
      <FaqSection faq={faq} />
    </main>
  );
};

/** Assistenter: the CMS texts, the admission status from PostgreSQL, and the FAQ. The application form is Phase 3. */
export const Route = createFileRoute("/assistenter")({
  component: AssistantsPage,
  head: () => ({ meta: [{ title: "Assistenter – Vektorprogrammet" }] }),
  loader: () => getAssistantsPage().then(pageData),
});
