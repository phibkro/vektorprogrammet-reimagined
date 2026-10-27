/**
 * The Worker entry (Cloudflare's documented custom-entry pattern for TanStack
 * Start): `fetch` answers legacy redirects, then delegates to TanStack's
 * server entry with `{ env, ctx }` as the request context; `scheduled` runs the
 * outbox sweep, the semester job (spec 0003) and the "ending soon" digest (spec 0006), one cron every 10 minutes (see `alchemy.run.ts`).
 */
import type {
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import handler from "@tanstack/react-start/server-entry";
import { env as workerBindings } from "cloudflare:workers";
import { Effect, Match, Option, Predicate } from "effect";

import { handleAccountPost } from "./server/accountPost";
import { validateAuthStartup } from "./server/authStartup";
import type { WorkerEnv } from "./server/env";
import {
  classifyLegacyPath,
  legacyFileLocation,
  permanentRedirect,
} from "./server/redirects";
import {
  runAuthRequest,
  runDelivery,
  runEndingSoon,
  runQuery,
  runSemesterJob,
} from "./server/runtime";

validateAuthStartup(workerBindings.BETTER_AUTH_SECRET);

const accountActions = new Map<
  string,
  "activate" | "request-reset" | "reset-password"
>([
  ["/api/account/activate", "activate"],
  ["/api/account/request-reset", "request-reset"],
  ["/api/account/reset-password", "reset-password"],
]);

const startFetch = (
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> =>
  Promise.resolve(handler.fetch(request, { context: { ctx, env } }));

const fetch = (
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> => {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/auth/")) {
    return runAuthRequest(request, env);
  }

  const accountAction = accountActions.get(url.pathname);

  if (accountAction !== undefined) {
    return handleAccountPost(request, env, ctx, accountAction);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return startFetch(request, env, ctx);
  }

  const legacy = classifyLegacyPath(url.pathname, url.search);

  return Match.value(legacy).pipe(
    Match.tagsExhaustive({
      Alias: ({ location }) =>
        Effect.runPromise(Effect.succeed(permanentRedirect(location))),
      LegacyFile: ({ legacyPath }) =>
        runQuery(
          {
            ctx,
            env,
            headers: request.headers,
            signal: request.signal,
            testActor: undefined,
          },
          legacyFileLocation(legacyPath)
        ).then((outcome) =>
          Predicate.isTagged(outcome, "Success") && Option.isSome(outcome.value)
            ? permanentRedirect(outcome.value.value)
            : startFetch(request, env, ctx)
        ),
      None: () => startFetch(request, env, ctx),
    })
  );
};

export default {
  fetch,
  scheduled(
    _controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext
  ): void {
    // Independent jobs on one cron: no promise rejects, so one failing never cancels the other. The digest's
    // outbox rows are delivered by the sweep that follows it, and the sweep also takes everything else that is due.
    ctx.waitUntil(runSemesterJob(env));
    ctx.waitUntil(runEndingSoon(env).then(() => runDelivery(env)));
  },
};
