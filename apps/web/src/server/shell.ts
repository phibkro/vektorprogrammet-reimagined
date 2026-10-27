/**
 * What the control-panel shell shows a principal, derived from the one grant table through the one section
 * declaration (`panelAccess.ts`: what each section's page exercises, asked of `canAnywhere`). The guard of every
 * page's data reads the same declaration, so the sidebar offers a section exactly when its data is served (issue
 * 15). There is no second who-may-do-what list: the declaration names what a page exercises, never the role that
 * holds it (ADR 0001). Hiding is presentation; the data and the commands refuse a forged request with 403.
 */
import {
  CurrentPrincipal,
  PersonRepository,
  PrincipalDirectory,
} from "@vektorprogrammet/domain";
import type { Principal } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Predicate } from "effect";

import { PANEL_SECTIONS } from "../lib/panelSections";
import type { NavigationGroup } from "../lib/panelSections";
import type { Deployment } from "./deployment";
import { mayOpenSection } from "./panelAccess";

/** The sidebar for `principal`: the sections they may open, grouped; nothing for a principal that is not a person. */
export const navigationFor = (
  principal: Principal
): readonly NavigationGroup[] => {
  const usable = Arr.filter(PANEL_SECTIONS, (section) =>
    mayOpenSection(principal, section.key)
  );

  return Arr.map(
    Arr.dedupe(Arr.map(usable, (section) => section.group)),
    (label) => ({
      items: Arr.filter(usable, (section) => section.group === label),
      label,
    })
  );
};

/** Who is acting, as the shell shows it; null for a visitor who is not signed in. */
export interface ActorSummary {
  readonly name: string;
  readonly admin: boolean;
  readonly leader: boolean;
  readonly member: boolean;
}

export const actorSummary = (
  principal: Principal,
  name: string
): ActorSummary | null =>
  Predicate.isTagged(principal, "Person")
    ? {
        admin: principal.adminUntil !== undefined,
        leader: Arr.some(principal.memberships, (fact) => fact.leader),
        member: Arr.isReadonlyArrayNonEmpty(principal.memberships),
        name,
      }
    : null;

/** The name of the person who is acting; empty for a principal that is not a person. */
export const nameOfActor = Effect.gen(function* nameOfActor() {
  const principal = yield* CurrentPrincipal;

  if (!Predicate.isTagged(principal, "Person")) {
    return "";
  }

  const people = yield* PersonRepository;

  return yield* people.findById(principal.personId).pipe(
    Effect.map((person) => person.name),
    Effect.orElseSucceed(() => "")
  );
});

/**
 * The control-panel layout's data: who is acting, the sidebar they get, and the people the local test-actor switch
 * offers (only in a `local` deployment, the one place a test actor exists).
 */
export const shellView = (deployment: Deployment) =>
  Effect.gen(function* shellProgram() {
    const principal = yield* CurrentPrincipal;
    const name = yield* nameOfActor;
    const directory = yield* PrincipalDirectory;

    return {
      actor: actorSummary(principal, name),
      navigation: navigationFor(principal),
      testActors: deployment === "local" ? yield* directory.names(50) : null,
    };
  });
