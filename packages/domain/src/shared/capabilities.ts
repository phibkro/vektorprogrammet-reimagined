/**
 * Capability-based authorization: deny by default, scoped by department.
 *
 * `authorize` is the single decision table. Commands call `requireCapability`
 * inside their transaction (route guards in `apps/web` are UX only).
 */
import { Data, Effect } from "effect";
import { CurrentActor, type Actor, type Staff } from "./actor.ts";
import { Forbidden } from "./errors.ts";
import type { DepartmentId } from "./ids.ts";

export type Capability = Data.TaggedEnum<{
  /** C4, RULE-296: admin or executive-board member. */
  EditStaticContent: {};
  /** C1, RULE-144: admin. */
  ManageSemesters: {};
  /** C1: admin creates departments. */
  CreateDepartment: {};
  /** C1: admin, or a team leader of that department. */
  UpdateDepartment: { readonly departmentId: DepartmentId };
  /** C1, RULE-139: admin, or a team leader of that department. */
  ManageFieldsOfStudy: { readonly departmentId: DepartmentId };
  /** C5: any staff. */
  ManageArticles: {};
  /** C6: any staff. */
  ManageSponsors: {};
  /** C8: admin, or staff of that department. */
  ManageSocialEvents: { readonly departmentId: DepartmentId };
  /** C11: any staff. */
  UploadFiles: {};
  /** C12: admin. */
  ReadAudit: {};
}>;
export const Capability = Data.taggedEnum<Capability>();

/** The authorization decision table. Anonymous actors hold no capability. */
export const authorize = (actor: Actor, capability: Capability): boolean => {
  if (actor._tag === "Anonymous") return false;
  const isAdmin = actor.role === "admin";
  const leads = (departmentId: DepartmentId) =>
    actor.role === "teamLeader" && actor.departmentId === departmentId;
  switch (capability._tag) {
    case "EditStaticContent":
      return isAdmin || actor.executiveBoard;
    case "ManageSemesters":
    case "CreateDepartment":
    case "ReadAudit":
      return isAdmin;
    case "UpdateDepartment":
    case "ManageFieldsOfStudy":
      return isAdmin || leads(capability.departmentId);
    case "ManageArticles":
    case "ManageSponsors":
    case "UploadFiles":
      return true;
    case "ManageSocialEvents":
      return isAdmin || actor.departmentId === capability.departmentId;
  }
};

/** Fails with `Forbidden` unless the current actor holds the capability; returns the staff actor. */
export const requireCapability = Effect.fnUntraced(function* (capability: Capability) {
  const actor = yield* CurrentActor;
  if (actor._tag === "Staff" && authorize(actor, capability)) {
    return actor satisfies Staff;
  }
  return yield* new Forbidden({ capability: capability._tag });
});

/** Fails with `Forbidden` unless the current actor is staff; for commands whose scope comes from the actor. */
export const requireStaff = Effect.gen(function* () {
  const actor = yield* CurrentActor;
  if (actor._tag === "Staff") return actor satisfies Staff;
  return yield* new Forbidden({ capability: "Staff" });
});
