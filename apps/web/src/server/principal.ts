/**
 * Before sign-in (spec 0007) nobody is signed in, so the acting principal is `Anonymous`, except in a `local`
 * deployment, where the `vp-test-actor` cookie chooses one of the seeded people by name (`@vektorprogrammet/db`
 * `LOCAL_PEOPLE`; the default is `DEFAULT_LOCAL_PERSON`). `preview` and `production` can never yield a person, so every
 * command there is `Forbidden` by construction. A person's facts (the memberships active this semester, the admin
 * place) are loaded in one read before the program runs (`PrincipalDirectory`).
 */
import { DEFAULT_LOCAL_PERSON } from "@vektorprogrammet/db";
import {
  PrincipalDirectory,
  anonymous,
  currentSemester,
} from "@vektorprogrammet/domain";
import type { Principal } from "@vektorprogrammet/domain";
import { DateTime, Effect, Option } from "effect";

import { ANONYMOUS_CHOICE } from "../lib/testActor";
import type { Deployment } from "./deployment";

/**
 * `selection` is the raw cookie value, read before the Effect program starts. A name that is no one's is nobody:
 * `Anonymous`.
 */
export const resolvePrincipal = (
  deployment: Deployment,
  selection: string | undefined
): Effect.Effect<Principal, never, PrincipalDirectory> =>
  deployment !== "local" || selection === ANONYMOUS_CHOICE
    ? Effect.succeed(anonymous)
    : Effect.gen(function* resolveLocalPrincipal() {
        const directory = yield* PrincipalDirectory;

        const found = yield* directory.byName(
          selection ?? DEFAULT_LOCAL_PERSON,
          { current: yield* currentSemester, now: yield* DateTime.now }
        );

        return Option.getOrElse(found, () => anonymous);
      });
