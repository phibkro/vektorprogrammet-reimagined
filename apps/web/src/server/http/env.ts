/** Runtime bindings for the single Start Worker; secrets never enter browser configuration. */
import type { RateLimit, SendEmail } from "@cloudflare/workers-types";

export interface WorkerEnv {
  readonly DEPLOYMENT: string;
  /** Server-only restricted runtime PostgreSQL connection, never migration authority. */
  readonly DATABASE_URL: string;
  readonly SUPABASE_URL: string;
  readonly SUPABASE_PUBLISHABLE_KEY: string;
  /** Server-only privileged key, not a VITE_ variable. */
  readonly SUPABASE_SECRET_KEY: string;
  readonly CONTACT_RATE_LIMIT: RateLimit;
  readonly TURNSTILE_SITE_KEY: string;
  readonly TURNSTILE_SECRET_KEY: string;
  readonly SITE_URL: string;
  readonly SEND_EMAIL?: SendEmail;
  readonly MAIL_FROM?: string;
  readonly SLACK_WEBHOOK_URL?: string;
  readonly WORKSPACE_MODE?: string;
}
