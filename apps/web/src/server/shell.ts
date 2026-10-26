/**
 * What the control-panel shell shows a principal, derived from the one grant table: the domain's `canAnywhere`,
 * which reads the same rows as every command's `authorize`. Each section lists the commands and reads its page
 * exercises, and the sidebar offers the section to a principal who holds one of them for some department it
 * belongs to, or for everything. There is no second who-may-do-what list: this module names what a page exercises,
 * never the role that holds it (ADR 0001). Hiding is presentation; the commands still refuse a forged request
 * with 403.
 */
import {
  CurrentPrincipal,
  PersonRepository,
  PrincipalDirectory,
  canAnywhere,
} from "@vektorprogrammet/domain";
import type { Command, Principal } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Predicate } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

import { PANEL_SECTIONS } from "../lib/panelSections";
import type { NavigationGroup, SectionKey } from "../lib/panelSections";
import type { Deployment } from "./deployment";

/** The commands and reads each section's page exercises. */
const SECTION_COMMANDS: Readonly<
  Record<SectionKey, NonEmptyReadonlyArray<Command>>
> = {
  admins: ["grantAdmin", "revokeAdmin"],
  departments: ["createDepartment", "updateDepartment"],
  fieldsOfStudy: ["createFieldOfStudy", "renameFieldOfStudy"],
  overview: ["openControlPanel"],
  people: ["viewPeople", "registerPerson"],
  semesters: ["openControlPanel"],
  socialEvents: ["createSocialEvent"],
  teams: ["viewTeams", "createTeam"],
};

const mayUseSection = (principal: Principal, key: SectionKey): boolean =>
  Arr.some(SECTION_COMMANDS[key], (command) => canAnywhere(principal, command));

/** The sidebar for `principal`: the sections they may use, grouped; nothing for a principal that is not a person. */
export const navigationFor = (
  principal: Principal
): readonly NavigationGroup[] => {
  if (!Predicate.isTagged(principal, "Person")) {
    return [];
  }

  const usable = Arr.filter(PANEL_SECTIONS, (section) =>
    mayUseSection(principal, section.key)
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
