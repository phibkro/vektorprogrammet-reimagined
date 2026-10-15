/**
 * Worker settings shared by `alchemy.run.ts` (deployed Workers) and
 * `vite.config.ts` (standalone `vp dev` / `vp build`), so the two cannot
 * disagree. Binding NAMES are typed by `src/server/env.ts`.
 */
export const COMPATIBILITY_DATE = "2026-10-01";
export const COMPATIBILITY_FLAGS = ["nodejs_compat"];

/** The Worker's own entry: `fetch` + `scheduled` (Cloudflare's custom-entry pattern for TanStack Start). */
export const WORKER_MAIN = "src/server.ts";

export const PUBLIC_FILES_BUCKET = "vp-public-files";

/** `/kontakt` posts per client IP: 5 per 60 s (the binding allows periods of 10 or 60 s only). */
export const CONTACT_RATE_LIMIT = { namespaceId: 1001, limit: 5, period: 60 } as const;

/** Outbox sweep (architecture §4: every 5–15 min). */
export const OUTBOX_SWEEP_CRON = "*/10 * * * *";
