/**
 * Phase 1 has no authentication (Phase 2 adds Better Auth). The acting
 * principal is `Anonymous`, except in a `local` deployment, where a fixed
 * test actor can be selected with the `vp-test-actor` cookie. `preview` and
 * `production` can never yield a staff actor, so every staff command there is
 * `Forbidden` by construction.
 */
import {
  Actor,
  DepartmentId,
  UserId,
  anonymous,
} from "@vektorprogrammet/domain";
import type { Actor as ActorType, Staff } from "@vektorprogrammet/domain";
import { Array as Arr, Option } from "effect";

import { TEST_ACTOR_NAMES } from "../lib/testActor";
import type { TestActorName } from "../lib/testActor";
import type { Deployment } from "./deployment";

/** Fake ids (no legacy user); department 1 is whatever the local database holds as id 1. */
export const TEST_ACTORS: Readonly<Record<TestActorName, Staff>> = {
  admin: Actor.cases.Staff.make({
    departmentId: DepartmentId.make(1),
    executiveBoard: true,
    role: "admin",
    userId: UserId.make(900_001),
  }),
  teamLeader: Actor.cases.Staff.make({
    departmentId: DepartmentId.make(1),
    executiveBoard: false,
    role: "teamLeader",
    userId: UserId.make(900_002),
  }),
};

/**
 * `selection` is the raw cookie value, read before the Effect program starts.
 * Local default: the admin test actor; `anonymous` selects no actor.
 */
export const resolveActor = (
  deployment: Deployment,
  selection: string | undefined
): ActorType => {
  if (deployment !== "local" || selection === "anonymous") {
    return anonymous;
  }

  const name =
    Option.getOrUndefined(
      Arr.findFirst(TEST_ACTOR_NAMES, (candidate) => candidate === selection)
    ) ?? "admin";

  return TEST_ACTORS[name];
};
