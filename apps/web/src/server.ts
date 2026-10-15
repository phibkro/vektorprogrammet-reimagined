/**
 * The Worker entry (Cloudflare's documented custom-entry pattern for TanStack
 * Start): `fetch` answers legacy redirects, then delegates to TanStack's
 * server entry with `{ env, ctx }` as the request context; `scheduled` is the
 * outbox sweep (cron, every 10 minutes; see `alchemy.run.ts`).
 */
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import handler from "@tanstack/react-start/server-entry";
import { Option } from "effect";
import type { WorkerEnv } from "./server/env";
import { classifyLegacyPath, legacyFileLocation, permanentRedirect } from "./server/redirects";
import { runDelivery, runQuery } from "./server/runtime";

const startFetch = (request: Request, env: WorkerEnv, ctx: ExecutionContext) =>
  Promise.resolve(handler.fetch(request, { context: { env, ctx } }));

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return startFetch(request, env, ctx);
    const url = new URL(request.url);
    const legacy = classifyLegacyPath(url.pathname, url.search);
    switch (legacy._tag) {
      case "None":
        return startFetch(request, env, ctx);
      case "Alias":
        return Promise.resolve(permanentRedirect(legacy.location));
      case "LegacyFile":
        return runQuery(
          { env, ctx, signal: request.signal, testActor: undefined },
          legacyFileLocation(legacy.legacyPath),
        ).then((outcome) =>
          outcome._tag === "Success" && Option.isSome(outcome.value)
            ? permanentRedirect(outcome.value.value)
            : startFetch(request, env, ctx),
        );
    }
  },

  scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(runDelivery(env));
  },
};
