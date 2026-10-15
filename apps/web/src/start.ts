/**
 * Start instance: TanStack's built-in CSRF middleware (architecture §4,
 * critic m10). It checks `Sec-Fetch-Site` / `Origin` (Referer as fallback) on
 * every server function call AND on every non-GET page request, which covers
 * the no-JavaScript `/kontakt` form post.
 */
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) =>
    ctx.handlerType === "serverFn" ||
    (ctx.request.method !== "GET" && ctx.request.method !== "HEAD"),
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
}));
