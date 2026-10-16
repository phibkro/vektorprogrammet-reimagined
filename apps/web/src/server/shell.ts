/**
 * What the control-panel shell shows an actor, derived from the one authorization decision table: the
 * domain's `authorize`, the function every command's `requireCapability` calls. Each section lists the
 * capabilities its page exercises, and the sidebar offers the section to an actor who holds one of them
 * (a section that lists none is for any staff member). There is no second who-may-do-what list: this module
 * names the capability a page exercises, never the role that holds it. Hiding is presentation; the commands
 * still refuse a forged request with 403.
 */
import { Capability, CurrentActor, authorize } from "@vektorprogrammet/domain";
import type { Actor, Staff, StaffRole } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Predicate } from "effect";

import { PANEL_SECTIONS } from "../lib/panelSections";
import type { NavigationGroup, SectionKey } from "../lib/panelSections";
import type { Deployment } from "./deployment";

/**
 * The capabilities each section's page exercises. A department-scoped capability is asked for the actor's
 * own department: that is the department the domain scopes a staff member's capabilities to.
 */
const SECTION_CAPABILITIES: Readonly<
  Record<SectionKey, (actor: Staff) => readonly Capability[]>
> = {
  articles: () => [Capability.ManageArticles()],
  departments: (actor) => [
    Capability.CreateDepartment(),
    Capability.UpdateDepartment({ departmentId: actor.departmentId }),
  ],
  fieldsOfStudy: (actor) => [
    Capability.ManageFieldsOfStudy({ departmentId: actor.departmentId }),
  ],
  overview: () => [],
  semesters: () => [],
  socialEvents: (actor) => [
    Capability.ManageSocialEvents({ departmentId: actor.departmentId }),
  ],
  sponsors: () => [Capability.ManageSponsors()],
  staticContent: () => [Capability.EditStaticContent()],
};

const mayUseSection = (actor: Staff, key: SectionKey): boolean => {
  const exercised = SECTION_CAPABILITIES[key](actor);

  return (
    exercised.length === 0 ||
    Arr.some(exercised, (capability) => authorize(actor, capability))
  );
};

/** The sidebar for `actor`: the sections they may use, grouped; nothing for an actor who is not staff. */
export const navigationFor = (actor: Actor): readonly NavigationGroup[] => {
  if (!Predicate.isTagged(actor, "Staff")) {
    return [];
  }

  const usable = Arr.filter(PANEL_SECTIONS, (section) =>
    mayUseSection(actor, section.key)
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
  readonly departmentId: number;
  readonly executiveBoard: boolean;
  readonly role: StaffRole;
}

export const actorSummary = (actor: Actor): ActorSummary | null =>
  Predicate.isTagged(actor, "Staff")
    ? {
        departmentId: actor.departmentId,
        executiveBoard: actor.executiveBoard,
        role: actor.role,
      }
    : null;

/**
 * The control-panel layout's data: who is acting, the sidebar they get, and whether the local test-actor
 * switch is offered (only in a `local` deployment, the one place a test actor exists).
 */
export const shellView = (deployment: Deployment) =>
  Effect.map(CurrentActor, (actor) => ({
    actor: actorSummary(actor),
    navigation: navigationFor(actor),
    testActors: deployment === "local",
  }));
