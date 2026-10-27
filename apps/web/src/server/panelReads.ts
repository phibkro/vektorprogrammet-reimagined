/**
 * The programs of the control panel's read server functions (`functions/panel.functions.ts`), each behind the guard
 * of its section (issue 15): a principal who may not open the section (`panelAccess.ts`, the declaration the sidebar
 * reads too) is refused with `Forbidden` (403) before a row is read, so a page the sidebar hides gets no 2xx and no
 * data. What a served page lists is still filtered row by row with `authorize`, inside each view.
 *
 * A server function runs `panelReads.<its own name>`, never a view directly: `test/panelReads.test.ts` fails on a
 * GET function that does not.
 */
import { Effect } from "effect";

import { integrationsView } from "./integrations";
import {
  dashboardView,
  departmentsView,
  fieldsOfStudyView,
  semestersView,
  socialEventsView,
} from "./panel";
import { READ_SECTIONS, requireSection } from "./panelAccess";
import type { PanelRead } from "./panelAccess";
import { adminsView, peopleView, teamView, teamsView } from "./teams";

const guarded = <A, E, R>(read: PanelRead, view: Effect.Effect<A, E, R>) =>
  Effect.andThen(requireSection(READ_SECTIONS[read]), view);

export const panelReads = {
  getAdmins: guarded("getAdmins", adminsView),
  getDashboard: guarded("getDashboard", dashboardView),
  getDepartments: guarded("getDepartments", departmentsView),
  getFieldsOfStudy: guarded("getFieldsOfStudy", fieldsOfStudyView),
  getIntegrations: guarded("getIntegrations", integrationsView),
  getPeople: guarded("getPeople", peopleView),
  getSemesters: guarded("getSemesters", semestersView),
  getSocialEvents: guarded("getSocialEvents", socialEventsView),
  getTeam: (id: number) => guarded("getTeam", teamView(id)),
  getTeams: guarded("getTeams", teamsView),
} as const;
