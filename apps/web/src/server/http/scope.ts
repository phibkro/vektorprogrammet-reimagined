/**
 * Reads everything a program needs from the active TanStack request, before
 * the Effect program starts (architecture §3: fibers never call TanStack
 * request helpers). Server-only.
 */
import { getRequest } from "@tanstack/react-start/server";

import type { RequestScope } from "../runtime";
import type { RequestContext } from "./context";

export const requestScope = (context: RequestContext): RequestScope => ({
  ctx: context.ctx,
  env: context.env,
  headers: getRequest().headers,
  signal: getRequest().signal,
});
