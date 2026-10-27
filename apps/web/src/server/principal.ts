/** A Better Auth session identifies a person; the domain's Account state and grants decide their authority. */
import { DEFAULT_LOCAL_PERSON } from "@vektorprogrammet/db";
import {
  PrincipalDirectory,
  anonymous,
  currentSemester,
} from "@vektorprogrammet/domain";
import type { PersonPrincipal, Principal } from "@vektorprogrammet/domain";
import { DateTime, Effect, Option } from "effect";

import { ANONYMOUS_CHOICE } from "../lib/testActor";
import { Auth } from "./auth";
import type { Deployment } from "./deployment";

const atCurrentTime = Effect.all({
  current: currentSemester,
  now: DateTime.now,
});

const browserPrincipal = (
  found: Option.Option<PersonPrincipal>,
  sessionId?: string
): Principal =>
  Option.match(found, {
    onNone: () => anonymous,
    onSome: (person) => {
      const browser = { ...person, client: "browser" as const };

      return sessionId === undefined ? browser : { ...browser, sessionId };
    },
  });

/** Invalid or inactive login sessions are anonymous, even if a local test-actor cookie is also present. */
export const resolvePrincipal = Effect.fn("resolvePrincipal")(
  function* resolvePrincipalFromSession(
    deployment: Deployment,
    selection: string | undefined,
    headers: Headers
  ): Effect.fn.Return<Principal, never, Auth | PrincipalDirectory> {
    const auth = yield* Auth;
    const session = yield* Effect.orDie(auth.session(headers));
    const directory = yield* PrincipalDirectory;

    if (session.value !== null) {
      const sessionId = session.value.session.id;

      const found = yield* directory.activeById(
        session.value.user.personId,
        yield* atCurrentTime
      );

      return browserPrincipal(found, sessionId);
    }

    if (
      session.cookiePresent ||
      deployment !== "local" ||
      selection === ANONYMOUS_CHOICE
    ) {
      return anonymous;
    }

    const found = yield* directory.byName(
      selection ?? DEFAULT_LOCAL_PERSON,
      yield* atCurrentTime
    );

    return browserPrincipal(found);
  }
);
