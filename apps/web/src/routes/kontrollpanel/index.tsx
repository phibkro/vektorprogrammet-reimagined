import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr, pipe } from "effect";

import { getDashboard } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";
import { TEST_ACTOR_COOKIE } from "@/lib/testActor";
import type { TestActorName } from "@/lib/testActor";

const TEST_ACTOR_CHOICES: readonly {
  value: TestActorName | "anonymous";
  label: string;
}[] = [
  { label: "Admin (testaktør)", value: "admin" },
  { label: "Anonym", value: "anonymous" },
  { label: "Teamleder (testaktør)", value: "teamLeader" },
];

const routeApi = getRouteApi("/kontrollpanel/");

const Dashboard = () => {
  const { actor, currentSemester } = routeApi.useLoaderData();

  return (
    <section className="grid gap-4">
      <h1 className="text-2xl font-bold">Kontrollpanel</h1>
      <p>
        Nåværende semester: <strong>{currentSemester}</strong>
      </p>
      <p>
        Innlogget som:{" "}
        <strong>
          {actor === null
            ? "anonym (ingen tilgang til endringer)"
            : `${actor.role}, avdeling ${actor.departmentId}${actor.executiveBoard ? ", hovedstyret" : ""}`}
        </strong>
      </p>
      <fieldset className="grid max-w-sm gap-2 rounded-lg border p-4">
        <legend className="px-1 text-sm font-semibold">
          Testaktør (virker bare lokalt)
        </legend>
        {pipe(
          TEST_ACTOR_CHOICES,
          Arr.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className="text-left text-sm underline"
              onClick={() => {
                void cookieStore
                  .set({
                    name: TEST_ACTOR_COOKIE,
                    path: "/",
                    sameSite: "lax",
                    value: choice.value,
                  })
                  .then(() => {
                    window.location.reload();
                  });
              }}
            >
              {choice.label}
            </button>
          ))
        )}
      </fieldset>
    </section>
  );
};

/** C2: the current semester (RULE-033; created when missing, RULE-237) and who is acting. */
export const Route = createFileRoute("/kontrollpanel/")({
  component: Dashboard,
  loader: () => getDashboard().then(pageData),
});
