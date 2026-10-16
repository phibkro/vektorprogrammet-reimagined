/**
 * Capability-based authorization: deny by default, scoped by department.
 *
 * `authorize` is the single decision table. Commands call `requireCapability`
 * inside their transaction (route guards in `apps/web` are UX only).
 */
import { Data, Effect, Predicate } from "effect";

import { CurrentActor } from "./actor.ts";
import type { Actor, Staff } from "./actor.ts";
import { Forbidden } from "./errors.ts";
import type { DepartmentId } from "./ids.ts";

export type Capability = Data.TaggedEnum<{
  /** C4, RULE-296: admin or executive-board member. */
  EditStaticContent: Record<never, never>;
  /** C1: admin creates departments. */
  CreateDepartment: Record<never, never>;
  /** C1: admin, or a team leader of that department. */
  UpdateDepartment: { readonly departmentId: DepartmentId };
  /** C1, RULE-139: admin, or a team leader of that department. */
  ManageFieldsOfStudy: { readonly departmentId: DepartmentId };
  /** C5: any staff. */
  ManageArticles: Record<never, never>;
  /** C6: any staff. */
  ManageSponsors: Record<never, never>;
  /** C8: admin, or staff of that department. */
  ManageSocialEvents: { readonly departmentId: DepartmentId };
  /** C11: any staff. */
  UploadFiles: Record<never, never>;
  /** C12: admin. */
  ReadAudit: Record<never, never>;
}>;

export const Capability = Data.taggedEnum<Capability>();

/** The authorization decision table. Anonymous actors hold no capability. */
export const authorize = (actor: Actor, capability: Capability): boolean => {
  if (!Predicate.isTagged(actor, "Staff")) {
    return false;
  }

  const isAdmin = actor.role === "admin";

  const leads = (departmentId: DepartmentId) =>
    actor.role === "teamLeader" && actor.departmentId === departmentId;

  return Capability.$match(capability, {
    CreateDepartment: () => isAdmin,
    EditStaticContent: () => isAdmin || actor.executiveBoard,
    ManageArticles: () => true,
    ManageFieldsOfStudy: ({ departmentId }) => isAdmin || leads(departmentId),
    ManageSocialEvents: ({ departmentId }) =>
      isAdmin || actor.departmentId === departmentId,
    ManageSponsors: () => true,
    ReadAudit: () => isAdmin,
    UpdateDepartment: ({ departmentId }) => isAdmin || leads(departmentId),
    UploadFiles: () => true,
  });
};

/** Fails with `Forbidden` unless the current actor holds the capability; returns the staff actor. */
export const requireCapability = Effect.fnUntraced(function* requireCapability(
  capability: Capability
) {
  const actor = yield* CurrentActor;

  if (Predicate.isTagged(actor, "Staff") && authorize(actor, capability)) {
    return actor satisfies Staff;
  }

  return yield* new Forbidden({ capability: capability._tag });
});

/** Fails with `Forbidden` unless the current actor is staff; for commands whose scope comes from the actor. */
export const requireStaff = Effect.gen(function* requireStaff() {
  const actor = yield* CurrentActor;

  if (Predicate.isTagged(actor, "Staff")) {
    return actor satisfies Staff;
  }

  return yield* new Forbidden({ capability: "Staff" });
});
