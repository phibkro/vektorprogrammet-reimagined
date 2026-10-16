/**
 * Department navigation and team cards, ported from mono-web's `TeamTabs` (`apps/homepage/src/components/team-tabs.tsx`,
 * commit 2aa6ce97). Without a slug the first department is selected. The departments are PostgreSQL's; the teams
 * are the CMS's (`teams`, matched by city). Mono-web's application link and deadline are Phase 3 and are not ported.
 */
import { Link } from "@tanstack/react-router";
import { Array as Arr } from "effect";
import { Mail } from "lucide-react";

import { departmentLinkClass } from "@/components/site/pageParts";
import type { DepartmentView, TeamView } from "@/server/site/pages";

const TeamCard = ({ team }: { readonly team: TeamView }) => (
  <article className="bg-vektor-light-blue flex h-full min-h-48 flex-col rounded-md shadow-md">
    <div className="bg-vektor-blue flex min-h-20 items-center justify-center rounded-t-md px-3 py-2">
      <h3 className="text-vektor-darkblue min-w-0 text-center text-lg font-medium">
        {team.name}
      </h3>
    </div>
    <div className="flex grow flex-col gap-3 p-3 text-sm">
      {team.description !== null && (
        <p className="whitespace-pre-line">{team.description}</p>
      )}
      {team.email !== null && (
        <p className="flex items-start gap-2">
          <Mail aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <a
            className="min-w-0 break-all hover:underline"
            href={`mailto:${team.email}`}
          >
            {team.email}
          </a>
        </p>
      )}
    </div>
  </article>
);

export const TeamTabs = ({
  departments,
  selected,
  teams,
}: {
  readonly departments: readonly DepartmentView[];
  readonly selected: DepartmentView | null;
  readonly teams: readonly TeamView[];
}) => (
  <div className="mb-6 flex w-full flex-col gap-8 px-5 lg:flex-row">
    {departments.length > 0 && (
      <nav
        aria-label="Velg avdeling"
        className="flex flex-wrap gap-2 lg:w-48 lg:shrink-0 lg:flex-col"
      >
        {Arr.map(departments, (department) => (
          <Link
            aria-current={department.id === selected?.id ? "page" : undefined}
            className={departmentLinkClass(department.id === selected?.id)}
            key={department.id}
            params={{ department: department.slug }}
            to="/team/$department"
          >
            {department.shortName}
          </Link>
        ))}
      </nav>
    )}
    <div className="w-full min-w-0">
      {selected === null ? (
        <p role="status">Ingen avdelinger er publisert ennå.</p>
      ) : (
        <section
          aria-labelledby="department-heading"
          className="flex flex-col gap-6"
        >
          <h2
            className="text-vektor-gray text-2xl font-bold"
            id="department-heading"
          >
            {selected.name}
          </h2>
          {teams.length === 0 ? (
            <p role="status">Ingen team er publisert ennå.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
              {Arr.map(teams, (team) => (
                <li className="min-w-0" key={team.name}>
                  <TeamCard team={team} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  </div>
);
