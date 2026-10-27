import { createFileRoute } from "@tanstack/react-router";

import { exportOwnFile, exportResponse } from "@/server/personalData";
import { runCommand } from "@/server/runtime";
import { requestScope } from "@/server/scope";

/**
 * Min side's download (spec 0007b, GDPR Art. 15 and 20): a form post, because the export is audited and so is a command,
 * and a command is never a GET. The CSRF middleware of `src/start.ts` checks `Sec-Fetch-Site` and `Origin` on every
 * non-GET request, so another site's form post is refused before this runs, and Better Auth's default cookie is
 * `SameSite=Lax` (`better-auth/dist/cookies/index.mjs`), so it would carry no session either.
 */
export const Route = createFileRoute("/api/eksport")({
  server: {
    handlers: {
      POST: ({ context }) =>
        runCommand(requestScope(context), exportOwnFile).then(exportResponse),
    },
  },
});
