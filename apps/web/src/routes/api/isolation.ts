import { createFileRoute } from "@tanstack/react-router";

import { isolationReport, isolationResponse } from "@/server/isolation";
import { runQuery } from "@/server/runtime";
import { requestScope } from "@/server/scope";

/**
 * What the store reports about the isolation of its transactions on this deployment, and whether it is what the domain
 * promises (spec 0018 R10, falsifier 4). A Preview answers it, so the pull request's check sees what Hyperdrive does
 * with the `BEGIN` of the adapter; production answers an empty 404 and opens no domain transaction.
 */
export const Route = createFileRoute("/api/isolation")({
  server: {
    handlers: {
      GET: ({ context }) =>
        runQuery(
          requestScope(context),
          isolationReport(context.env.DEPLOYMENT)
        ).then(isolationResponse),
    },
  },
});
