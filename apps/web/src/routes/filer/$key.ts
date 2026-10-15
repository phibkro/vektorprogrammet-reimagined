import { createFileRoute } from "@tanstack/react-router";
import { servePublicFile } from "@vektorprogrammet/domain";
import { publicFileResponse } from "@/server/publicFiles";
import { runQuery } from "@/server/runtime";
import { requestScope } from "@/server/scope";

/** C11 `/filer/{key}`: registered public files only (RULE-290 replacement). */
export const Route = createFileRoute("/filer/$key")({
  server: {
    handlers: {
      GET: ({ request, context, params }) =>
        runQuery(requestScope(context), servePublicFile(params.key)).then((outcome) =>
          publicFileResponse(outcome, request.method),
        ),
    },
  },
});
