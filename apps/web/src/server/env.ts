/**
 * The Worker's bindings and the per-request context TanStack Start carries.
 *
 * `alchemy.run.ts` declares the bindings and asserts at compile time that its
 * inferred env satisfies `WorkerEnv`, so a renamed or missing binding fails the
 * type check instead of failing in production. `vite.config.ts` declares the
 * same names for standalone `vp dev` (local only).
 */
import type {
  ExecutionContext,
  Hyperdrive,
  R2Bucket,
  RateLimit,
  SendEmail,
} from "@cloudflare/workers-types";

import type { ContactFormState } from "./contactPost";

export interface WorkerEnv {
  /** `local` | `preview` | `production`; decoded by `deployment.ts`, never compared as a raw string elsewhere. */
  readonly DEPLOYMENT: string;
  /** Neon through Hyperdrive with query caching disabled (locally: `DATABASE_URL`). */
  readonly HYPERDRIVE: Hyperdrive;
  /** R2 bucket `vp-public-files` (EU jurisdiction, no public access). */
  readonly PUBLIC_FILES: R2Bucket;
  /** Per-IP limit for the `/kontakt` form post. */
  readonly CONTACT_RATE_LIMIT: RateLimit;
  /** Turnstile site key (public, rendered into the contact form). */
  readonly TURNSTILE_SITE_KEY: string;
  /** Turnstile secret (Worker secret). */
  readonly TURNSTILE_SECRET_KEY: string;
  /** Production only: Cloudflare Email Service binding. */
  readonly SEND_EMAIL?: SendEmail;
  /** Production only: sender address for outbox e-mail. */
  readonly MAIL_FROM?: string;
  /** Production only: Slack incoming webhook (Worker secret). */
  readonly SLACK_WEBHOOK_URL?: string;
}

/** What `src/server.ts` passes into every TanStack Start request. */
export interface RequestContext {
  readonly env: WorkerEnv;
  readonly ctx: ExecutionContext;
  readonly contactForm?: ContactFormState;
}

declare module "@tanstack/react-router" {
  interface Register {
    server: {
      requestContext: RequestContext;
    };
  }
}
