/**
 * What the Workspace domain declares about its stored columns (spec 0008, on the declarations of spec 0007b): the
 * namespace of company addresses and the report of the projection.
 */
import {
  Rules,
  columns,
  notPersonal,
  ofPerson,
  personal,
  table,
} from "../personalData/declaration.ts";
import { Periods } from "../personalData/periods.ts";
import { afterColumn, withThePersonCore } from "../personalData/retentions.ts";

/**
 * The one namespace of company addresses: a person's `company_email` and a team's group address are rows of it, so no
 * two owners hold one address. A person's row says the same as `person.company_email`, so it lives and dies with the
 * person core: erasure, retention and a merge delete it, which releases the address. A team's row has no person and no
 * period.
 */
const companyAddress = table({
  columns: {
    ...columns(
      personal({
        legalBasis: "contract",
        onExpiry: Rules.Delete,
        purpose: "engagements",
        retention: withThePersonCore,
      }),
      ["address", "person_id"]
    ),
    team_id: notPersonal(
      "A team's id: the row is the claim of a team's group address, which names the team and not a person"
    ),
  },
  person: ofPerson("person_id", Rules.Drop),
});

/**
 * One run of the projection: the lists name people by address and id, nested in the report's sections, so the report
 * has no person key that finds them, and erasure does not reach it. It is a snapshot with a short period, and the next
 * report no longer names a person whose address and memberships are gone.
 */
const workspaceReport = table({
  columns: {
    ...columns(
      personal({
        legalBasis: "legitimateInterest",
        onExpiry: Rules.Delete,
        purpose: "workspace",
        retention: afterColumn("started_at", Periods.workspaceReports, {
          en: "the report was started",
          no: "rapporten ble startet",
        }),
      }),
      ["accounts", "department_lists", "groups", "issues", "unmanaged"]
    ),
    ...columns(
      notPersonal(
        "Report bookkeeping: counts, times, the mode, the status, the period and the semester; it holds no value about a person"
      ),
      [
        "actual",
        "completed_at",
        "counts",
        "id",
        "mode",
        "period",
        "semester_term",
        "semester_year",
        "started_at",
        "status",
      ]
    ),
  },
  person: null,
});

export const WorkspaceTables = {
  company_address: companyAddress,
  workspace_report: workspaceReport,
} as const;
