import { DateTime, Effect, Option } from "effect";

import { anonymous } from "../../domain/kernel/principal";
import type { Principal } from "../../domain/kernel/principal";
import { currentSemester } from "../../features/organisation/domain/commands";
/** Supabase verifies identity; current domain account state and grants decide authority. */
import { PrincipalDirectory } from "../../features/teams/domain/services";
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
