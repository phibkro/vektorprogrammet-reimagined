/**
 * Reads everything a program needs from the active TanStack request, before
 * the Effect program starts (architecture §3: fibers never call TanStack
 * request helpers). Server-only.
 */
import { getCookie, getRequest } from "@tanstack/react-start/server";
import { TEST_ACTOR_COOKIE } from "../lib/testActor";
import type { RequestContext } from "./env";
import type { RequestScope } from "./runtime";

export const requestScope = (context: RequestContext): RequestScope => ({
  env: context.env,
  ctx: context.ctx,
  signal: getRequest().signal,
  testActor: getCookie(TEST_ACTOR_COOKIE),
});
