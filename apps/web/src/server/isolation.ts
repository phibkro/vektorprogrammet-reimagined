/**
 * `GET /api/isolation` (spec 0018 R10, falsifier 4, the deployed path): what the store reports about the isolation of its
 * transactions, and whether that is what the domain promises (TX3). A Worker Preview reaches its database through
 * Hyperdrive, so what the platform does with the `BEGIN` that the adapter sends can only be read from the store.
 * `.github/workflows/preview.yml` calls the route on every pull request and fails unless it answers 200.
 *
 * The report (`IsolationProbe`, adapter in `packages/db`) holds three levels, and `isolationProblems` is the one place
 * that says what they must be: a `Transactor.run` transaction reads `read committed`; a transaction that the adapter's
 * mechanism begins at SERIALIZABLE reads `serializable` (a platform that drops the clause reads the role's default
 * there, so the check cannot pass by luck); and the role's own default, which the statements outside a transaction run
 * at, is `read committed`. The route answers 200 when no problem is found and 500 with the problems when one is.
 *
 * A production Worker answers an empty 404 and opens no domain transaction: the route is a check of previews and local
 * runs (the `main` stage, a preview deployment, answers it too, but no job asks it), and the answer on production is
 * `None` before the store is asked. So nothing asserts the role's default on production yet: STATE.md names the
 * follow-up, to be done when production is deployed (spec 0018 R18).
 */
import { IsolationProbe } from "@vektorprogrammet/domain";
import type { IsolationReport } from "@vektorprogrammet/domain";
import type { Option } from "effect";

import type { Outcome } from "../lib/outcome";
import { diagnosticReport, diagnosticResponse } from "./diagnosticResponse";
import type { WorkerEnv } from "./env";

const EXPECTED = {
  probe: "serializable",
  roleDefault: "read committed",
  transactor: "read committed",
} as const satisfies IsolationReport;

/** Why a report is not what the domain promises; empty when it is. Total and pure: the one statement of the check. */
export const isolationProblems = (
  report: IsolationReport
): readonly string[] => {
  const problems: string[] = [];

  if (report.transactor !== EXPECTED.transactor) {
    problems.push(
      `a Transactor.run transaction reads "${report.transactor}", not "${EXPECTED.transactor}" (TX3)`
    );
  }

  if (report.probe !== EXPECTED.probe) {
    problems.push(
      `a transaction begun at SERIALIZABLE reads "${report.probe}", not "${EXPECTED.probe}": the platform does not forward the clause`
    );
  }

  if (report.roleDefault !== EXPECTED.roleDefault) {
    problems.push(
      `the role's default reads "${report.roleDefault}", not "${EXPECTED.roleDefault}": statements outside a transaction run at it`
    );
  }

  return problems;
};

/** The store's report, or `None` on a production deployment (which asks the store nothing). */
export const isolationReport = (setting: WorkerEnv["DEPLOYMENT"]) =>
  diagnosticReport(setting, () => IsolationProbe.use((probe) => probe.report));

/** The report as JSON with its problems: 200 when there are none, 500 otherwise; 404 on production; the failure's own status otherwise. */
export const isolationResponse = (
  outcome: Outcome<Option.Option<IsolationReport>>
) =>
  diagnosticResponse(outcome, (report) => {
    const problems = isolationProblems(report);

    return { body: { ...report, problems }, problems };
  });
