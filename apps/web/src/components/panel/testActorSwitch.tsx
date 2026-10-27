import { Array as Arr, Effect } from "effect";

import { ANONYMOUS_CHOICE, TEST_ACTOR_COOKIE } from "@/lib/testActor";

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
 * data says so, with the names of the seeded people), and picking a choice reloads the page as that person.
 */
export const TestActorSwitch = ({ people }: { people: readonly string[] }) => (
  <fieldset className="border-border grid max-w-sm gap-2 rounded-lg border p-4">
    <legend className="px-1 text-sm font-semibold">
      Testaktør (virker bare lokalt)
    </legend>
    {Arr.map(people, (name) => (
      <button
        key={name}
        type="button"
        className="text-left text-sm underline"
        onClick={() => {
          choose(name);
        }}
      >
        {name}
      </button>
    ))}
    <button
      type="button"
      className="text-left text-sm underline"
      onClick={() => {
        choose(ANONYMOUS_CHOICE);
      }}
    >
      Anonym
    </button>
  </fieldset>
);
