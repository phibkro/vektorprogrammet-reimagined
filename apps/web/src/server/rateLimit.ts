/**
 * Per-IP rate limit for the `/kontakt` form post (architecture §4), over the
 * Cloudflare Rate Limiting binding. The limit itself (requests per period) is
 * configured on the binding in `alchemy.run.ts`.
 */
import type { RateLimit } from "@cloudflare/workers-types";
import { Context, Effect, Layer } from "effect";
import { RateLimited } from "./errors";

export class ContactRateLimiter extends Context.Service<
  ContactRateLimiter,
  { check(remoteIp: string | null): Effect.Effect<void, RateLimited> }
>()("@vektorprogrammet/web/server/ContactRateLimiter") {}

/** Requests without a client IP share one bucket, so they cannot bypass the limit. */
const keyOf = (remoteIp: string | null): string => `kontakt:${remoteIp ?? "unknown"}`;

export const contactRateLimiterLayer = (binding: RateLimit): Layer.Layer<ContactRateLimiter> =>
  Layer.succeed(
    ContactRateLimiter,
    ContactRateLimiter.of({
      check: (remoteIp) =>
        Effect.promise(() => binding.limit({ key: keyOf(remoteIp) })).pipe(
          Effect.flatMap(({ success }) => (success ? Effect.void : Effect.fail(new RateLimited()))),
        ),
    }),
  );

/** Test Layer: allows the first `allowed` checks per key, then limits. */
export const contactRateLimiterTestLayer = (allowed: number): Layer.Layer<ContactRateLimiter> =>
  Layer.sync(ContactRateLimiter, () => {
    const counts = new Map<string, number>();
    return ContactRateLimiter.of({
      check: (remoteIp) =>
        Effect.suspend(() => {
          const key = keyOf(remoteIp);
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return count > allowed ? Effect.fail(new RateLimited()) : Effect.void;
        }),
    });
  });
