import { createFileRoute } from "@tanstack/react-router";

import type { WorkerEnv } from "../../server/http/env";

/** The running preview version, not the control-plane's most recent upload. */
export const previewVersionResponse = (
  env: Pick<WorkerEnv, "DEPLOYMENT" | "PREVIEW_HEAD_SHA">
): Response => {
  const headSha = env.PREVIEW_HEAD_SHA;

  if (
    env.DEPLOYMENT !== "preview" ||
    headSha === undefined ||
    !/^[a-f0-9]{40}$/u.test(headSha)
  ) {
    return new Response(null, {
      headers: { "Cache-Control": "no-store" },
      status: 404,
    });
  }

  return Response.json(
    { headSha },
    { headers: { "Cache-Control": "no-store" } }
  );
};

export const Route = createFileRoute("/api/preview-version")({
  server: {
    handlers: {
      GET: ({ context }) => previewVersionResponse(context.env),
    },
  },
});
