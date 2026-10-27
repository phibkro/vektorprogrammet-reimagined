/**
 * Every retention period, one declaration each (spec 0007b R1 item 8). The columns of the catalog name these values and
 * never repeat a number, so a period changes in one place, and approving a proposal is a one-line change of its
 * `approval`: the generated record of processing and the retention schedule print "proposed, awaiting operator
 * approval" next to each proposed one (`docs/system/administration.md`).
 *
 * The `decided` values come from the operator's decisions of 2026-10-26 (`INFORMATION_MODEL.md` §11.7 and §11.9). The
 * `proposed` ones are the brief's proposals, or this slice's own for data that no decision names.
 */
import { days, period, years } from "./declaration.ts";

export const Periods = {
  /** `admin_grant`: a place on the admin list is kept as long as the audit trail it belongs with (proposed). */
  adminPlaceAfterEnd: period(years(3), "proposed"),
  /** `audit_log`: ids and action names, never values (§11.3, proposed). */
  auditRows: period(years(3), "proposed"),
  /** `captured_mail`: the non-production mailbox (proposed). */
  capturedMail: period(days(30), "proposed"),
  /** `captured_slack`: the non-production Slack, beside the mailbox (spec 0008, proposed). */
  capturedSlack: period(days(30), "proposed"),
  /** `code`: a code is dead at its expiry; the row is kept a while for support (proposed). */
  codeAfterExpiry: period(days(30), "proposed"),
  /** `membership`: who was a member or assistant where and when (§11.7 decision 6). */
  engagementHistory: period(years(10), "decided"),
  /**
   * `job_run`: a scheduled job's periods, whose `last_error` can carry what a provider said (spec 0008, proposed). A
   * row is the claim that makes a period run once, so it must outlive its period: the longest period is a semester
   * (Vår, from 1 January to 1 August), and a claim that was forgotten sooner would let the semester job run the same
   * semester again (`test/jobs/registry.test.ts`).
   */
  jobRuns: period(years(1), "proposed"),
  /** `outbox`: sent e-mails carry addresses (§11.3, proposed). */
  outboxRows: period(days(30), "proposed"),
  /** The person's core fields: one year after the last activity ends (§11.9 decision 1). */
  personCore: period(years(1), "decided"),
  /** The same, while a `keepDetails` consent is current (§11.9 decision 1). */
  personCoreWithKeepDetails: period(years(5), "decided"),
  /** `auth_session` and `auth_verification`: the row goes when the session or token expires (§11.3). */
  sessionExpiry: period(days(0), "decided"),
  /** `workspace_report`: a snapshot of the Google Workspace projection, which holds addresses (spec 0008, proposed). */
  workspaceReports: period(days(30), "proposed"),
} as const;
