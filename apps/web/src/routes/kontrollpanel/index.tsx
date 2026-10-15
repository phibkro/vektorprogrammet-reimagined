import { createFileRoute } from "@tanstack/react-router";
import { getDashboard } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";
import { TEST_ACTOR_COOKIE, type TestActorName } from "@/lib/testActor";

const TEST_ACTOR_CHOICES: ReadonlyArray<{ value: TestActorName | "anonymous"; label: string }> = [
  { value: "admin", label: "Admin (testaktør)" },
  { value: "teamLeader", label: "Teamleder (testaktør)" },
  { value: "anonymous", label: "Anonym" },
];

/** C2: the current semester (RULE-033; created when missing, RULE-237) and who is acting. */
export const Route = createFileRoute("/kontrollpanel/")({
  loader: () => getDashboard().then(pageData),
  component: Dashboard,
});

function Dashboard() {
  const { actor, currentSemester } = Route.useLoaderData();
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
        <legend className="px-1 text-sm font-semibold">Testaktør (virker bare lokalt)</legend>
        {TEST_ACTOR_CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className="text-left text-sm underline"
            onClick={() => {
              document.cookie = `${TEST_ACTOR_COOKIE}=${choice.value}; path=/; SameSite=Lax`;
              window.location.reload();
            }}
          >
            {choice.label}
          </button>
        ))}
      </fieldset>
    </section>
  );
}
