import { createFileRoute } from "@tanstack/react-router";

import { runPlatformRoute } from "@/server/platform";
import { requestScope } from "@/server/scope";

/**
 * What the store shows of the properties that the domain asks of its platform, on this deployment (spec 0025 R5). A
 * Preview answers it, so the pull request's check sees what Hyperdrive does with two transactions, a savepoint and the
 * client's statements; production answers an empty 404 and runs no probe. The route is `runPlatformRoute` and nothing
 * else, so that a test calls what the route calls.
 */
export const Route = createFileRoute("/api/platform")({
  server: {
    handlers: {
      GET: ({ context }) => runPlatformRoute(requestScope(context)),
    },
  },
});
