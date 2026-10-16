/**
 * Start instance: TanStack's built-in CSRF middleware (architecture §4,
 * critic m10). It checks `Sec-Fetch-Site` / `Origin` (Referer as fallback) on
 * every server function call AND on every non-GET page request, which covers
 * the no-JavaScript `/kontakt` form post. Every server function reply also carries
 * the HTTP status of the typed failure it answers with (`server/outcomeStatus.ts`).
 */
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

import { outcomeStatusMiddleware } from "./server/outcomeStatus";

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) =>
    ctx.handlerType === "serverFn" ||
    (ctx.request.method !== "GET" && ctx.request.method !== "HEAD"),
});

export const startInstance = createStart(() => ({
  functionMiddleware: [outcomeStatusMiddleware],
  requestMiddleware: [csrfMiddleware],
}));
