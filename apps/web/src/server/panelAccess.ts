/**
 * Who may open a control-panel section: the one declaration (issue 15). The sidebar (`shell.ts`) and the guard of
 * every page's data (`panelReads.ts`) both read it, so a section the sidebar hides is a section whose data answers
 * 403, and there is no second list. It names what a page exercises (the reads and commands of the domain's grant
 * table), never the role that holds it (ADR 0001); `canAnywhere` asks the table.
 *
 * A principal opens a section when it holds one of the section's commands or reads for some department it belongs
 * to, or for everything. What a page then lists is filtered row by row with `authorize`, underneath.
 */
import {
  CurrentPrincipal,
  Forbidden,
  canAnywhere,
} from "@vektorprogrammet/domain";
import type { Command, Principal } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Predicate } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

import type { SectionKey } from "../lib/panelSections";

/** The commands and reads each section's page exercises. */
export const SECTION_COMMANDS: Readonly<
  Record<SectionKey, NonEmptyReadonlyArray<Command>>
> = {
  admins: ["createAdminGrant", "deleteAdminGrant"],
  admission: ["viewAdmission", "createAdmissionPeriod"],
  departments: ["createDepartment", "updateDepartment"],
  fieldsOfStudy: ["createFieldOfStudy", "updateFieldOfStudy"],
  impact: ["listImpact"],
  integrations: ["viewIntegrations", "createWorkspaceReport"],
  overview: ["openControlPanel"],
  people: ["viewPeople", "createPerson", "mergePersons"],
  semesters: ["openControlPanel"],
  socialEvents: ["createSocialEvent"],
  teams: ["viewTeams", "createTeam"],
};

/**
 * The section each control-panel read server function (`functions/panel.functions.ts`) belongs to. A page is the
 * section of its path (`PANEL_SECTIONS`, `sectionOfPath`), and its data is the read function of that section.
 * `getShell` is not here: it is the sidebar itself, and answers every principal with the sections it may open.
 */
export const READ_SECTIONS = {
  getAdmins: "admins",
  getAdmission: "admission",
  getDashboard: "overview",
  getDepartments: "departments",
  getFieldsOfStudy: "fieldsOfStudy",
  getImpact: "impact",
  getIntegrations: "integrations",
  getPeople: "people",
  getSemesters: "semesters",
  getSocialEvents: "socialEvents",
  getTeam: "teams",
  getTeams: "teams",
} as const satisfies Readonly<Record<string, SectionKey>>;

export type PanelRead = keyof typeof READ_SECTIONS;

/** Whether `principal` may open `key`: a person who holds one of the section's commands for some scope. */
export const mayOpenSection = (
  principal: Principal,
  key: SectionKey
): boolean =>
  Predicate.isTagged(principal, "Person") &&
  Arr.some(SECTION_COMMANDS[key], (command) => canAnywhere(principal, command));

/**
 * The current principal when it may open `key`; `Forbidden` (403, the refusal an anonymous visitor gets) otherwise,
 * before any row is read.
 */
export const requireSection = Effect.fnUntraced(function* requireSection(
  key: SectionKey
) {
  const principal = yield* CurrentPrincipal;

  if (mayOpenSection(principal, key)) {
    return principal;
  }

  return yield* new Forbidden({ command: SECTION_COMMANDS[key][0] });
});
