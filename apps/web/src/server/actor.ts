/**
 * Phase 1 has no authentication (Phase 2 adds Better Auth). The acting
 * principal is `Anonymous`, except in a `local` deployment, where a fixed
 * test actor can be selected with the `vp-test-actor` cookie. `preview` and
 * `production` can never yield a staff actor, so every staff command there is
 * `Forbidden` by construction.
 */
import { DepartmentId, UserId, anonymous, type Actor, type Staff } from "@vektorprogrammet/domain";
import { TEST_ACTOR_NAMES, type TestActorName } from "../lib/testActor";
import type { Deployment } from "./deployment";

/** Fake ids (no legacy user); department 1 is whatever the local database holds as id 1. */
export const TEST_ACTORS: Readonly<Record<TestActorName, Staff>> = {
  admin: {
    _tag: "Staff",
    userId: UserId.make(900_001),
    departmentId: DepartmentId.make(1),
    role: "admin",
    executiveBoard: true,
  },
  teamLeader: {
    _tag: "Staff",
    userId: UserId.make(900_002),
    departmentId: DepartmentId.make(1),
    role: "teamLeader",
    executiveBoard: false,
  },
};

/**
 * `selection` is the raw cookie value, read before the Effect program starts.
 * Local default: the admin test actor; `anonymous` selects no actor.
 */
export const resolveActor = (deployment: Deployment, selection: string | undefined): Actor => {
  if (deployment !== "local" || selection === "anonymous") return anonymous;
  const name = TEST_ACTOR_NAMES.find((candidate) => candidate === selection) ?? "admin";
  return TEST_ACTORS[name];
};
