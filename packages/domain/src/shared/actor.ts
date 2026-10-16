/**
 * Who is acting. `apps/web` reads the session before the Effect program starts
 * and provides `CurrentActor` per request. Phase 1 has no real authentication:
 * the only actors are `Anonymous` and test-session staff. Phase 2 (Better Auth)
 * derives `Staff` from accounts and memberships; the shape below is the contract
 * it fills.
 */
import { Context, Schema } from "effect";

import { DepartmentId, UserId } from "./ids.ts";

/** Staff roles, ordered by authority: teamMember < teamLeader < admin. */
export const StaffRole = Schema.Literals(["teamMember", "teamLeader", "admin"]);

export type StaffRole = typeof StaffRole.Type;

export const Actor = Schema.TaggedUnion({
  Anonymous: {},
  Staff: {
    /** The staff member's own department; department-scoped capabilities compare against it. */
    departmentId: DepartmentId,
    /** Current member of the executive board (hovedstyret); independent of `role`. */
    executiveBoard: Schema.Boolean,
    role: StaffRole,
    userId: UserId,
  },
});

export type Actor = typeof Actor.Type;

export type Staff = Extract<Actor, { readonly _tag: "Staff" }>;

export type Anonymous = Extract<Actor, { readonly _tag: "Anonymous" }>;

export const anonymous: Anonymous = Actor.cases.Anonymous.make({});

/** The acting principal for the current request. */
export class CurrentActor extends Context.Service<CurrentActor, Actor>()(
  "@vektorprogrammet/domain/shared/CurrentActor"
) {}
