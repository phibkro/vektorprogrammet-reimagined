import { Array as Arr, Effect } from "effect";

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

const choose = (value: string) => {
  Effect.tryPromise(() =>
    cookieStore.set({
      name: TEST_ACTOR_COOKIE,
      path: "/",
      sameSite: "lax",
      value,
    })
  ).pipe(
    Effect.andThen(
      Effect.sync(() => {
        window.location.reload();
      })
    ),
    Effect.catch((error) =>
      Effect.logError("the test actor could not be selected", error)
    ),
    Effect.runFork
  );
};

/**
 * Who is acting, by cookie, for local development: the one deployment with a test actor offers this (the shell
 * data says so), and picking a choice reloads the page as that actor.
 */
export const TestActorSwitch = () => (
  <fieldset className="border-border grid max-w-sm gap-2 rounded-lg border p-4">
    <legend className="px-1 text-sm font-semibold">
      Testaktør (virker bare lokalt)
    </legend>
    {Arr.map(TEST_ACTOR_CHOICES, (choice) => (
      <button
        key={choice.value}
        type="button"
        className="text-left text-sm underline"
        onClick={() => {
          choose(choice.value);
        }}
      >
        {choice.label}
      </button>
    ))}
  </fieldset>
);
