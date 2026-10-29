import { createFileRoute } from "@tanstack/react-router";

import { platformReport, platformResponse } from "@/server/platform";
import { runProbe } from "@/server/runtime";
import { requestScope } from "@/server/scope";

/**
 * What the store shows of the properties that the domain asks of its platform, on this deployment (spec 0025 R5). A
 * Preview answers it, so the pull request's check sees what Hyperdrive does with two transactions, a savepoint and the
 * client's statements; production answers an empty 404 and runs no probe.
 */
export const Route = createFileRoute("/api/platform")({
  server: {
    handlers: {
      GET: ({ context }) =>
        runProbe(
          requestScope(context),
          platformReport(context.env.DEPLOYMENT)
        ).then(platformResponse),
    },
  },
});
