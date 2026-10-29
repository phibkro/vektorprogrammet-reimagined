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
import { Effect, Option, Predicate } from "effect";

import type { Outcome } from "../lib/outcome";
import { decodeDeployment } from "./deployment";
import type { WorkerEnv } from "./env";

/** The store's report with the deployment it was read on, or `None` on a production deployment (which asks nothing). */
export const platformReport = (setting: WorkerEnv["DEPLOYMENT"]) =>
  Effect.gen(function* reportOfThePlatform() {
    const deployment = yield* decodeDeployment(setting);

    if (deployment === "production") {
      return Option.none<{
        readonly deployment: string;
        readonly report: PlatformReport;
      }>();
    }

    const report = yield* PlatformProbe.use((probe) => probe.report);

    return Option.some({ deployment, report });
  });

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} satisfies Readonly<Record<string, string>>;

/** The report as JSON with its problems: 200 when there are none, 500 otherwise; 404 on production; the failure's own status otherwise. */
export const platformResponse = (
  outcome: Outcome<
    Option.Option<{
      readonly deployment: string;
      readonly report: PlatformReport;
    }>
  >
) => {
  if (Predicate.isTagged(outcome, "Failure")) {
    return new Response(outcome.message, {
      headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" },
      status: outcome.status,
    });
  }

  return Option.match(outcome.value, {
    onNone: () => new Response(null, { headers: HEADERS, status: 404 }),
    onSome: ({ deployment, report }) => {
      const problems = platformProblems(report);

      return Response.json(
        { ...report, deployment, problems },
        { headers: HEADERS, status: problems.length === 0 ? 200 : 500 }
      );
    },
  });
};
