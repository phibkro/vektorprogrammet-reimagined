import { createFileRoute } from "@tanstack/react-router";

import { requestScope } from "@/server/http/scope";
import { runQuery } from "@/server/runtime";

import { servePublicFile } from "../../features/files/domain/commands";
import { publicFileResponse } from "../../features/files/server/publicFiles";

/** C11 `/filer/{key}`: registered public files only (RULE-290 replacement). */
export const Route = createFileRoute("/filer/$key")({
  server: {
    handlers: {
      GET: ({ request, context, params }) =>
        runQuery(requestScope(context), servePublicFile(params.key)).then(
          (outcome) => publicFileResponse(outcome, request.method)
        ),
    },
  },
});
