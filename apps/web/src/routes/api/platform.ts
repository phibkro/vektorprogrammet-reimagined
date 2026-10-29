import { createFileRoute } from "@tanstack/react-router";

import { platformReport, platformResponse } from "@/server/platform";
import { liveRequestLayer, runOutcome } from "@/server/runtime";
import { requestScope } from "@/server/scope";

/**
 * What the store shows of the properties that the domain asks of its platform, on this deployment (spec 0025 R5). A
 * Preview answers it, so the pull request's check sees what Hyperdrive does with two transactions, a savepoint and the
 * client's statements; production answers an empty 404 and runs no probe.
 *
 * It runs through `runOutcome` over the live request layer and not through `runQuery`: a query must not write, and the
 * probe takes a row lock and writes rows that it rolls back, so it is not one of the read paths that
 * `readsNeverWrite.postgres.test.ts` runs as a role that can only read.
 */
export const Route = createFileRoute("/api/platform")({
  server: {
    handlers: {
      GET: ({ context }) => {
        const scope = requestScope(context);

        return runOutcome(
          liveRequestLayer(scope),
          platformReport(context.env.DEPLOYMENT),
          scope.signal
        ).then(platformResponse);
      },
    },
  },
});
