/** Supabase verifies identity; current domain account state and grants decide authority. */
import {
  PrincipalDirectory,
  anonymous,
  currentSemester,
} from "@vektorprogrammet/domain";
import type { Principal } from "@vektorprogrammet/domain";
import { DateTime, Effect, Option } from "effect";

import { Auth } from "./auth";

export const resolvePrincipal = Effect.fn("resolvePrincipal")(
  function* resolvePrincipalFromSession(
    headers: Headers
  ): Effect.fn.Return<Principal, never, Auth | PrincipalDirectory> {
    const session = yield* Effect.orDie((yield* Auth).session(headers));

    if (session.personId === null) {
      return anonymous;
    }

    const found = yield* (yield* PrincipalDirectory).activeById(
      session.personId,
      {
        current: yield* currentSemester,
        now: yield* DateTime.now,
      }
    );

    return Option.match(found, {
      onNone: () => anonymous,
      onSome: (person) => ({ ...person, client: "browser" as const }),
    });
  }
);
