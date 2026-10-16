import type { StaffRole } from "@vektorprogrammet/domain";

import type { ActorSummary } from "../server/shell";

const ROLE_LABEL: Readonly<Record<StaffRole, string>> = {
  admin: "Administrator",
  teamLeader: "Teamleder",
  teamMember: "Teammedlem",
};

/** Who is acting, in words: the role, the department and (when it applies) the executive board. */
export const actorLabel = (actor: ActorSummary): string =>
  `${ROLE_LABEL[actor.role]}, avdeling ${actor.departmentId}${actor.executiveBoard ? ", hovedstyret" : ""}`;
