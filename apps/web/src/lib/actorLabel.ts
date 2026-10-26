import type { ActorSummary } from "../server/shell";

/** What a person is in the system, in words, from the facts of their principal: no stored role. */
const describe = (actor: ActorSummary): string => {
  if (actor.admin) {
    return "administrator";
  }

  if (actor.leader) {
    return "teamleder";
  }

  return actor.member ? "teammedlem" : "uten team";
};

/** Who is acting, in words: the name and what they are. */
export const actorLabel = (actor: ActorSummary): string =>
  `${actor.name}, ${describe(actor)}`;
