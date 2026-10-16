/**
 * The team page of mono-web (`apps/homepage/src/routes/_home.team.tsx`, commit 2aa6ce97): the header text and a
 * picture, the department tabs with their team cards, and the FAQ. One component serves `/team` (the first
 * department) and `/team/{department}`.
 */
import { Divider, FaqSection } from "@/components/site/pageParts";
import { PortableTextView } from "@/components/site/portableTextView";
import { TeamTabs } from "@/components/site/teamTabs";
import type { TeamPageView } from "@/server/site/pages";

export const TeamPage = ({ view }: { readonly view: TeamPageView }) => (
  <main className="mx-auto mt-20 mb-20 flex w-full max-w-6xl flex-col items-center">
    <header className="mx-auto flex w-full flex-wrap justify-around">
      <div className="mt-5 flex max-w-md flex-col px-3">
        <PortableTextView
          className="[&_h2]:text-vektor-gray mb-20 text-xl [&_h1]:text-left [&_h2]:text-left"
          value={view.texts["team-header"] ?? null}
        />
      </div>
      <div className="relative mt-10">
        <img
          alt=""
          className="mx-auto max-h-80 w-auto max-w-full object-contain"
          src="/images/teacher2.png"
        />
      </div>
    </header>
    <h1 className="text-vektor-gray mx-auto mt-10 mb-10 max-w-lg text-center text-5xl font-bold">
      Våre team
    </h1>
    <TeamTabs
      departments={view.departments}
      selected={view.selected}
      teams={view.teams}
    />
    <Divider />
    <div className="flex w-full flex-col items-center md:mt-20">
      <FaqSection faq={view.faq} />
    </div>
  </main>
);
