/**
 * `GET /api/platform` (spec 0025 R5): what the store shows of the properties that the domain asks of its platform
 * (`PlatformRequirements`), measured on the platform this deployment reaches its database through. A Worker Preview
 * reaches it through Hyperdrive, so what the pooler does with two transactions, a savepoint and the statements of the
 * client can only be read from the store itself; `.github/workflows/preview.yml` calls the route on every pull request and
 * fails unless it answers 200. Under `vp dev` the same route answers from a direct connection: the report names the
 * connection profile that the adapter ran with and the deployment, and cannot tell a pooler from none.
 *
 * `platformProblems` (domain) is the one statement of what a report must hold: a required check that is missing fails as
 * surely as one that did not hold. A production Worker answers an empty 404 and asks the store nothing, as
 * `/api/isolation` does.
 */
import { PlatformProbe, platformProblems } from "@vektorprogrammet/domain";
import type { PlatformReport } from "@vektorprogrammet/domain";
import { Effect } from "effect";
import type { Option } from "effect";

import type { Outcome } from "../lib/outcome";
import { diagnosticReport, diagnosticResponse } from "./diagnosticResponse";
import type { WorkerEnv } from "./env";
import { liveRequestLayer, runOutcome } from "./runtime";
import type { RequestScope } from "./runtime";

/** The store's report with the deployment it was read on, or `None` on a production deployment (which asks nothing). */
export const platformReport = (setting: WorkerEnv["DEPLOYMENT"]) =>
  diagnosticReport(setting, (deployment) =>
    PlatformProbe.use((probe) =>
      Effect.map(probe.report, (report) => ({ deployment, report }))
    )
  );

/** The report as JSON with its problems: 200 when there are none, 500 otherwise; 404 on production; the failure's own status otherwise. */
export const platformResponse = (
  outcome: Outcome<
    Option.Option<{
      readonly deployment: string;
      readonly report: PlatformReport;
    }>
  >
) =>
  diagnosticResponse(outcome, ({ deployment, report }) => {
    const problems = platformProblems(report);

    return { body: { ...report, deployment, problems }, problems };
  });

/**
 * What `GET /api/platform` does, from the request's scope to its answer. It runs through `runOutcome` over the live
 * request layer and not through `runQuery`: a query must not write, and the probe takes a row lock and writes rows that
 * it rolls back, so it is not one of the read paths that `readsNeverWrite.postgres.test.ts` runs as a role that can only
 * read. A test calls this, so the production answer is tested where the route has it.
 */
export const runPlatformRoute = (scope: RequestScope) =>
  runOutcome(
    liveRequestLayer(scope),
    platformReport(scope.env.DEPLOYMENT),
    scope.signal
  ).then(platformResponse);
