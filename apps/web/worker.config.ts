import { Config, Effect } from "effect";

/**
 * Worker settings shared by `alchemy.run.ts` (deployed Workers) and
 * `vite.config.ts` (standalone `vp dev` / `vp build`), so the two cannot
 * disagree. Binding NAMES are typed by `src/server/env.ts`.
 */
export const COMPATIBILITY_DATE = "2026-10-01";

/**
 * `enable_request_signal` has no default date: without it `request.signal` never aborts, so a
 * cancelled request ran its transaction to COMMIT (slice 0000, check 3b; `docs/specs/0000-results.md`).
 *
 * `global_fetch_strictly_public` routes `fetch()` like a request from the public Internet, which is how this
 * Worker reads the CMS Worker (`apps/cms`) by URL (spec 0005, R1); without it a Worker's fetch to another
 * Worker is refused with Cloudflare error 1042
 * (https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public).
 * It changes `fetch()` only; the Hyperdrive binding is not a `fetch()` and is not affected, which the first
 * Preview of spec 0005 confirms.
 */
export const COMPATIBILITY_FLAGS = [
  "nodejs_compat",
  "enable_request_signal",
  "global_fetch_strictly_public",
];

/**
 * The CMS Worker (`apps/cms`): `nodejs_compat` for Astro's server runtime and `pg`. It reads no other Worker by
 * `fetch()`, so it needs neither of the flags above.
 */
export const CMS_COMPATIBILITY_FLAGS = ["nodejs_compat"];

/** The Worker's own entry: `fetch` + `scheduled` (Cloudflare's custom-entry pattern for TanStack Start). */
export const WORKER_MAIN = "src/server.ts";

/**
 * The long-lived non-production stage built from `main`. Every other non-production stage deploys as a
 * Cloudflare Worker Preview of this stage's Worker (spec 0002); `production` is the production deployment.
 */
export const BASE_STAGE = "main";

/** Production's bucket keeps the plain name; every other stage gets its own, so no stage can write production files. */
export const publicFilesBucket = (stage: string): string =>
  stage === "production" ? "vp-public-files" : `vp-public-files-${stage}`;

/** The CMS's media bucket (spec 0005): the same rule, so no stage can write production's media. */
export const cmsMediaBucket = (stage: string): string =>
  stage === "production" ? "vp-cms-media" : `vp-cms-media-${stage}`;

/**
 * Cloudflare's documented always-pass Turnstile test keys
 * (https://developers.cloudflare.com/turnstile/troubleshooting/testing/). Public by design; only
 * production reads real keys.
 */
export const TURNSTILE_TEST_KEYS = {
  secretKey: "1x0000000000000000000000000000000AA",
  siteKey: "1x00000000000000000000AA",
} as const;

/** Neon through Hyperdrive, as the role whose user and password are named by these deploy-time env vars. */
const neonOriginAs = (userVariable: string, passwordVariable: string) =>
  Effect.gen(function* neonConnection() {
    return {
      database: yield* Config.NonEmptyString("NEON_DATABASE"),
      host: yield* Config.NonEmptyString("NEON_HOST"),
      password: yield* Config.Redacted(passwordVariable),
      scheme: "postgres" as const,
      user: yield* Config.NonEmptyString(userVariable),
    };
  });

/**
 * The Hyperdrive origin every stack reads (`apps/web`, `tools/db-path-spike`): Neon as the DML-only
 * role `vp_app`, from deploy-time env (CI, or `tools/with-neon-env.sh app` locally).
 */
export const neonOrigin = neonOriginAs("NEON_USER", "NEON_APP_PASSWORD");

/**
 * Where the Neon project runs. The project was created outside Alchemy, so this is the one declaration of its
 * region: the Workers are placed next to it (`WORKER_PLACEMENT`), and the Preview workflow fails when the live
 * project's `region_id` differs from it (`.github/workflows/preview.yml`, spec 0000c).
 */
export const NEON_REGION = "aws-eu-central-1";

/**
 * Targeted placement next to the database (spec 0000c). Every statement is a round trip between the Worker and
 * Neon; slice 0000's placement run measured a median of 1014 ms of database time for 17 sequential statements from
 * Cloudflare's default placement and 216 ms from Frankfurt (`docs/specs/0000-placement-results.md`). Neon's
 * `aws-<region>` is Cloudflare's `aws:<region>`.
 */
export const WORKER_PLACEMENT = {
  mode: "targeted",
  region: `aws:${NEON_REGION.slice("aws-".length)}`,
} as const;

/**
 * The CMS's Hyperdrive origin (spec 0005, D1): the same Neon database as the application, as the role
 * `emdash_app` that owns the schema `emdash` (`apps/cms/db/emdash-role.sql`).
 */
export const emdashOrigin = neonOriginAs(
  "NEON_EMDASH_USER",
  "NEON_EMDASH_PASSWORD"
);

/** `/kontakt` posts per client IP: 5 per 60 s (the binding allows periods of 10 or 60 s only). */
export const CONTACT_RATE_LIMIT = {
  limit: 5,
  namespaceId: 1001,
  period: 60,
} as const;

/**
 * The tick (every 10 minutes): the outbox sweep (architecture §4: every 5–15 min), the semester job (spec 0003), the
 * "ending soon" digest (spec 0006) and the alumni consent job (spec 0007b).
 */
export const OUTBOX_SWEEP_CRON = "*/10 * * * *";

/**
 * The nightly cron: the retention run (spec 0007b), as `System("retention")`. 02:17 UTC is 03:17 or 04:17 in Oslo: a
 * quiet hour, and not a minute that the tick also runs at. `scheduled` tells the two apart by `controller.cron`.
 */
export const RETENTION_CRON = "17 2 * * *";
