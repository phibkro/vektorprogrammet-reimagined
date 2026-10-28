import { createFileRoute } from "@tanstack/react-router";

import { isolationResponse, transactionIsolation } from "@/server/isolation";
import { runQuery } from "@/server/runtime";
import { requestScope } from "@/server/scope";

/**
 * The isolation level of a domain transaction on this deployment (spec 0018, falsifier 4). A Preview answers it, so the
 * pull request's check can see what Hyperdrive does with the explicit `BEGIN`; production answers 404.
 */
export const Route = createFileRoute("/api/isolation")({
  server: {
    handlers: {
      GET: ({ context }) =>
        runQuery(
          requestScope(context),
          transactionIsolation(context.env.DEPLOYMENT)
        ).then(isolationResponse),
    },
  },
});
