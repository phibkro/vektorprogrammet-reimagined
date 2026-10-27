/**
 * The Worker entry (Cloudflare's documented custom-entry pattern for TanStack
 * Start): `fetch` answers legacy redirects, then delegates to TanStack's
 * server entry with `{ env, ctx }` as the request context; `scheduled` runs the
 * outbox sweep, the semester job (spec 0003), the "ending soon" digest (spec 0006) and the alumni consent job (spec 0007b)
 * on one cron every 10 minutes, and the retention run (spec 0007b) on its own nightly cron (see `alchemy.run.ts`).
 */
import type {
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";
import handler from "@tanstack/react-start/server-entry";
import { env as workerBindings } from "cloudflare:workers";
import { Effect, Match, Option, Predicate } from "effect";

import { RETENTION_CRON } from "../worker.config";
import { handleAccountPost } from "./server/accountPost";
import { validateAuthStartup } from "./server/authStartup";
import type { WorkerEnv } from "./server/env";
import {
  classifyLegacyPath,
  legacyFileLocation,
  permanentRedirect,
} from "./server/redirects";
import {
  runAlumniConsent,
  runAuthRequest,
  runDelivery,
  runEndingSoon,
  runQuery,
  runRetention,
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
    controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext
  ): void {
    if (controller.cron === RETENTION_CRON) {
      ctx.waitUntil(runRetention(env));

      return;
    }

    // Independent jobs on one cron: no promise rejects, so one failing never cancels the other. The digest's and the
    // alumni job's outbox rows are delivered by the sweep that follows them, and the sweep also takes everything else
    // that is due.
    ctx.waitUntil(runSemesterJob(env));

    ctx.waitUntil(
      Promise.all([runEndingSoon(env), runAlumniConsent(env)]).then(() =>
        runDelivery(env)
      )
    );
  },
};
