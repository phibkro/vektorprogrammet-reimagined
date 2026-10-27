/**
 * What travels with a command into `decide`: who is acting, and the facts about other aggregates and rows that the
 * decision needs. An aggregate decides on its own state, so a fact that lives elsewhere (a team's department, whether
 * it is active, a person's department) is resolved by the sender, once, before the command is sent, and carried here.
 * A `RequestContext` has a schema because the platform stores and moves it (`SendMeta.context`).
 */
import * as Domain from "@alchemy.run/domain";
import {
  DefaultTerm,
  DepartmentId,
  Principal,
  PrincipalResource,
  TeamId,
} from "@vektorprogrammet/domain";
import { Schema } from "effect";

/** The acting principal of the kernel (`Anonymous`, `Person`, `System`), unchanged. */
export class RequestPrincipal extends Domain.RequestContext<RequestPrincipal>()(
  "vektorprogrammet/spike/RequestPrincipal",
  Principal
) {}

export const FactsSchema = Schema.Struct({
  /** The department of the person a command is about (the department of their field of study). */
  personDepartmentId: Schema.optionalKey(DepartmentId),
  /** What the grant table is asked about: one resource, or two for a move between departments. Empty: no resource. */
  resources: Schema.Array(PrincipalResource),
  /** The team a command is about, when it is about one. */
  team: Schema.optionalKey(
    Schema.Struct({
      active: Schema.Boolean,
      defaultTerm: DefaultTerm,
      departmentId: DepartmentId,
      id: TeamId,
    })
  ),
});

export type Facts = typeof FactsSchema.Type;

export class CommandFacts extends Domain.RequestContext<CommandFacts>()(
  "vektorprogrammet/spike/CommandFacts",
  FactsSchema
) {}
