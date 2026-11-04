# @vektorprogrammet/web

Vektorprogrammet's public site and control panel run in one TanStack Start Cloudflare Worker. Supabase provides PostgreSQL, Auth and Storage. Content editing is part of the control panel; there is no separate CMS process, Cloudflare Queue, R2 bucket or Hyperdrive binding.

## Run the synthetic local prototype

Follow [`tools/prototype/README.md`](../../tools/prototype/README.md) to start the official local Supabase services and obtain a private CLI status environment file. Use the pinned project toolchain:

```sh
devenv shell -- bun install
SUPABASE_ENV_FILE=/path/to/private-local-status.env devenv shell -- bun run prototype:setup
SUPABASE_ENV_FILE=/path/to/private-local-status.env devenv shell -- bun run prototype:dev
```

Open http://localhost:3000/logg-inn. The synthetic accounts and fixture password are declared in [`localPeople.ts`](../../packages/domain/src/localPeople.ts); the setup guide lists the login addresses. Setup is rerunnable and refuses a remote database/API target. It does not reset an existing database or overwrite edited content.

The application does not accept a test-actor cookie. Sign in through real local Supabase Auth. Supabase CLI's development keys are publicly shared defaults; ports may be bound beyond loopback. Never use this stack for real personal data or production credentials. Local Auth email is captured by the CLI's Mailpit service; application invitations and notifications use the non-production capture store.

## Runtime configuration

| Binding | Purpose |
| --- | --- |
| `DATABASE_URL` | Server-only PostgreSQL connection as a domain-table owner or BYPASSRLS role, with required Auth-schema reads. Hosted deployments use an appropriate Supabase pooler connection. |
| `SUPABASE_URL` | Auth and Storage API origin |
| `SUPABASE_PUBLISHABLE_KEY` | Public provider client key |
| `SUPABASE_SECRET_KEY` | Server-only privileged SDK key |
| `SITE_URL` | Application origin used in invitation/recovery links |
| `DEPLOYMENT` | Explicit local, preview or production mode |
| `CONTACT_RATE_LIMIT` | Worker-native per-IP limiter |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Spam protection; documented test keys locally |

Secret values are local runtime variables, never Vite browser variables. Standalone production builds contain empty database/secret bindings; Terraform supplies deployed values. Optional production mail, Slack and Workspace capabilities remain explicit operator-controlled integrations, not part of a safe synthetic deployment.

## Request and data boundaries

- Start server functions are the application's read/write entry points. Commands reuse the existing Effect domain rules and Drizzle/PostgreSQL transactions. Domain rows, audit and outbox intent commit together.
- The shared Drizzle table factory enables RLS without browser-role policies on domain tables. Anonymous and authenticated Data API clients cannot bypass Worker authorization. Provider Auth and Storage schemas keep their native policies. Before a hosted release, inspect exposed definer functions and owner-privileged views separately.
- Supabase verifies identities. Trusted administrator-owned `app_metadata.personId` links a provider identity to a domain person. Every protected application request checks current account state and domain grants. User-editable metadata never grants authority.
- Native provider invitations/recovery/password updates replace custom credential delivery. Recovery submits a provider one-time token to a fresh client at password-setting time. Session controls use supported sign-out scopes, not a fabricated per-session revocation API.
- JavaScript-owned forms declare POST and disable submission until hydration. Premature or forced native submission cannot place credentials or form fields in the URL. Native activation, export and contact forms retain their existing POST handlers.
- A private Supabase `public-files` bucket holds content-addressed objects. `/filer/$key` checks the domain registry and applies safe serving headers. A private object is not made anonymously readable merely because it has a public-file registry entry.
- Legacy public-file redirects use only the registry database layer. They run before Start installs its cookie context and require no authenticated principal.
- The in-process content adapter stores separate draft and published JSON snapshots. Visitors read only the published snapshot. The control panel uses the maintained Portable Text editor and existing collection schemas. Unsupported rich-content blocks remain read-only rather than undergoing destructive normalization. Only the browser editor loads through React lazy and TanStack ClientOnly. The route retains server rendering and authorization.
- Direct post-commit delivery and the scheduled recovery sweep share conditional due-time/lease-fenced Postgres claims. External delivery remains at least once. Provider identity deletion/relink intents survive prolonged outages and remain pending with backoff instead of expiring silently.
- Erasure/merge/retention commit domain changes before provider cleanup. The UI distinguishes local erasure from pending provider work. Arbitrary editorial content requires explicit manual privacy review.

## Deployment and verification

[`infra/terraform`](../../infra/terraform/README.md) is the sole owner of the hosted Worker artifact, assets, bindings and cron configuration, plus selected settings on an existing dedicated Supabase project. It derives Worker settings/modules from the actual Vite build output. No Alchemy application deployment or automatic legacy Neon/EmDash preview pipeline remains. Import, plan and apply require operator authority; local validation does not prove a hosted deployment.

```sh
devenv shell -- bunx vp -C apps/web build
devenv shell -- bunx vp check
```

Tests requiring Auth/Storage need the real local Supabase environment. SQL adapter tests use disposable databases and a minimal observed provider-schema fixture where they exercise SQL rather than the provider API. Browser tests must own their Supabase project/database, fixture users and app process; never reset the interactive prototype to run them. Turnstile test-key verification requires outbound access to Cloudflare's documented public test endpoint.

Spec [`0024`](../../docs/specs/0024-supabase-prototype.md) records the prototype contract and exercised evidence. Historical specs describe the previous infrastructure; they are not deployment instructions for this cutover. Production data/password/file migration, real delivery integrations and a hosted release remain separate gates. This infrastructure prototype does not claim that the still-unbuilt recruitment/placement phases are complete.
