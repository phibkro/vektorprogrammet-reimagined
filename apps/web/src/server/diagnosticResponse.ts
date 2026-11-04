/**
 * What the diagnostic routes of a non-production deployment share (`GET /api/isolation`, spec 0018 R10; `GET
 * /api/platform`, spec 0025 R5): asking the store only when the deployment is not production, and answering with the
 * report as JSON and its problems, 200 when there are none and 500 otherwise, an empty 404 when nothing was asked
 * (production), and the failure's own status when the request failed. One place, so that the two routes cannot differ.
 */
import { Effect, Option, Predicate } from "effect";

import type { Outcome } from "../lib/outcome";
import { decodeDeployment } from "./deployment";
import type { WorkerEnv } from "./env";

/** What `ask` reports, with the deployment it was read on; `None` on a production deployment, which asks the store nothing. */
export const diagnosticReport = <A, E, R>(
  setting: WorkerEnv["DEPLOYMENT"],
  ask: (deployment: string) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* reportOfTheStore() {
    const deployment = yield* decodeDeployment(setting);

    return deployment === "production"
      ? Option.none<A>()
      : Option.some(yield* ask(deployment));
  });

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
} satisfies Readonly<Record<string, string>>;

export const diagnosticResponse = <A>(
  outcome: Outcome<Option.Option<A>>,
  describe: (report: A) => {
    readonly body: unknown;
    readonly problems: readonly string[];
  }
): Response => {
  if (Predicate.isTagged(outcome, "Failure")) {
    return new Response(outcome.message, {
      headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" },
      status: outcome.status,
    });
  }

  return Option.match(outcome.value, {
    onNone: () => new Response(null, { headers: HEADERS, status: 404 }),
    onSome: (report) => {
      const { body, problems } = describe(report);

      return Response.json(body, {
        headers: HEADERS,
        status: problems.length === 0 ? 200 : 500,
      });
    },
  });
};
