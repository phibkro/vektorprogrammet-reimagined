/**
 * The spike Worker (spec 0000): `fetch` serves the checks. Like `apps/web`'s entry, it
 * runs each request's Effect with the request's `AbortSignal`, so an aborted request
 * interrupts the program and rolls back an open transaction. Handlers and checks live in
 * `worker/`; this is the only place that runs effects.
 */
import type { ExecutionContext } from "@cloudflare/workers-types";
import { Cause, Effect, Schema, String as Str } from "effect";

import { ABORT_READY_LINE, RunParams, routes } from "./protocol.ts";
import { abortTransaction } from "./worker/checks.ts";
import { requestDatabase } from "./worker/database.ts";
import type { SpikeEnv } from "./worker/database.ts";
import { route, withParams } from "./worker/http.ts";

const encoder = new TextEncoder();

/** The response stream refused a write: the client is gone. */
class StreamClosed extends Schema.TaggedError<
  StreamClosed,
  { readonly brand: unique symbol }
>()("StreamClosed", {}) {}

// Best effort: the client may be gone, and the transaction's fate must not depend on a write.
const bestEffort = (operation: () => Promise<void>) =>
  Effect.tryPromise({
    catch: () => new StreamClosed({}),
    try: operation,
  }).pipe(Effect.catchTag("StreamClosed", () => Effect.void));

/**
 * Check 3b, the one streaming route: the first line tells the caller the row is
 * written inside the open transaction, then the transaction waits. The caller aborts
 * the request; `request.signal` interrupts the waiting fiber and the transaction rolls
 * back. A finished program writes `committed`: nothing interrupted it.
 */
const streamAbortCheck = (
  request: Request,
  env: SpikeEnv,
  ctx: Pick<ExecutionContext, "waitUntil">
): Response => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const write = (line: string) =>
    bestEffort(() => writer.write(encoder.encode(`${line}\n`)));

  const program = withParams(RunParams, new URL(request.url), ({ run }) =>
    Effect.andThen(
      abortTransaction(run, write(ABORT_READY_LINE)),
      write("committed")
    )
  ).pipe(
    Effect.provide(requestDatabase(env)),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => write(`failed: ${Str.slice(0, 400)(Cause.pretty(cause))}`)
    ),
    Effect.ensuring(bestEffort(() => writer.close()))
  );

  ctx.waitUntil(Effect.runPromiseExit(program, { signal: request.signal }));

  return new Response(readable, {
    headers: {
      "cache-control": "no-store, no-transform",
      "content-type": "text/plain; charset=utf-8",
    },
  });
};

export default {
  fetch(
    request: Request,
    env: SpikeEnv,
    ctx: Pick<ExecutionContext, "waitUntil">
  ): Promise<Response> {
    return new URL(request.url).pathname === routes.abort
      ? Promise.resolve(streamAbortCheck(request, env, ctx))
      : Effect.runPromise(route(request, env), { signal: request.signal });
  },
};
