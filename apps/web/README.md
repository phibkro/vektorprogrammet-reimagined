# @vektorprogrammet/web

The one deployable: TanStack Start on one Cloudflare Worker. Public pages, `/kontrollpanel`, server functions (the only write path), legacy 301 redirects, `/filer/{key}`, and the outbox sweep. It holds no business rules; those live in `@vektorprogrammet/domain` and the database in `@vektorprogrammet/db`. This README covers the runtime model, the env and bindings, local development, and what slice 0000 must still prove.

## Runtime model

```
request ─► src/server.ts  fetch
             ├─ legacy alias (/om, /bedrifter, /faq, /artikkel/{slug})  → 301   (server/redirects.ts, one table)
             ├─ legacy file path (Offentlige filer/…, images/…)         → 301 /filer/{key} via PublicFileRepository.findByLegacyPath
             └─ TanStack Start handler, context = { env, ctx }
                  ├─ CSRF middleware (src/start.ts): server functions + every non-GET page request
                  ├─ server functions (src/functions/*.functions.ts)
                  ├─ server routes: /filer/$key (GET), /kontakt + /kontakt/avdeling/$id (POST, no-JS form)
                  └─ SSR routes (loaders call server functions)
cron ────► src/server.ts  scheduled → ctx.waitUntil(runDelivery(env))           (outbox sweep)
```

Each server function or server route:

1. Reads the request before Effect runs (`server/scope.ts`: env, `ctx`, the request's `AbortSignal`, the test-actor cookie; form fields and uploads are read in the handler).
2. Calls `runQuery`, `runCommand` or `runPreparedCommand` (`server/runtime.ts`). These build the **per-request Layer**:
   - `DatabaseLive({ url: env.HYPERDRIVE.connectionString, maxConnections: 2 })`
   - `FileStore` over the R2 binding (`server/fileStore.ts`)
   - `CurrentActor` (`server/actor.ts`)
   - Web Crypto `Crypto.Crypto` (`server/webCrypto.ts`)
   - `TurnstileVerifier` and `ContactRateLimiter`
   - `Transactor`, which wraps a command in `@vektorprogrammet/db`'s `transactional` (the only provider of `InTransaction`)
3. Runs the Effect with the request's `AbortSignal`. A prepared command runs `prepare` outside any transaction (provider I/O such as rate limit, Turnstile and R2 uploads), then the command inside one.
4. Maps typed failures through **one table** (`server/errors.ts`):

   | Error              | status | no-JS form re-render |
   | ------------------ | ------ | -------------------- |
   | `NotFound`         | 404    | 404                  |
   | `Forbidden`        | 403    | 403                  |
   | `AlreadyExists`    | 409    | 409                  |
   | `ValidationFailed` | 400    | 422                  |
   | `RateLimited`      | 429    | 429                  |

   It returns a serializable `Outcome` (`lib/outcome.ts`). Loaders turn a 404 into TanStack's `notFound()` (`pageData`). Defects are logged with their cause and rethrown, so the framework answers 500.

5. After a command commits, the outbox ids it enqueued are delivered in `ctx.waitUntil` (`claimDue({ ids })`). The cron sweep (every 10 minutes) claims every due row. Both send **outside** any transaction and mark each row delivered, or failed with backoff (5 min × 2ⁿ, at most 12 h). A row is dead after 8 attempts (`server/outboxDelivery.ts`).

### Deployment and the sandbox

`DEPLOYMENT` ∈ {`local`, `preview`, `production`} is decoded with Effect Schema (`server/deployment.ts`). A missing or unknown value is a defect; the code never guesses.

- **Message senders** (`server/senders.ts`): only `production` can build the Cloudflare Email Service (`send_email`) and Slack-webhook senders. `productionSenderLayer` fails to build for any other deployment, or when a production binding is missing. `local` and `preview` get a capture sink that records each message and logs only its kind. `test/sandbox.test.ts` proves both.
- **Actor** (Phase 1 has no auth): `Anonymous` everywhere, except `local`, where the `vp-test-actor` cookie selects a fixed test actor (`admin` (default), `teamLeader`, or `anonymous`). Switch it on `/kontrollpanel`. Outside `local`, every staff command is `Forbidden`.

### Routes

| Path | Capability | Rules |
| --- | --- | --- |
| `/` | C3 | RULE-331 (news), RULE-075 offsets dropped |
| `/omvektor`, `/foreldre` | C4 | static blocks (legacy `html_id`s) |
| `/nyheter`, `/nyheter/{department}`, `?page=N` | C5 | RULE-326, RULE-267 |
| `/nyhet/{slug}` | C5 | RULE-267 (draft → 404) |
| `/kontakt`, `/kontakt/avdeling/{id}` (GET + no-JS POST → 303 / 422) | C10 | RULE-156, 167, 249; per-IP rate limit |
| `/filer/{key}` | C11 | RULE-290 replacement |
| `/kontrollpanel` + `avdelinger`, `semestre`, `linjer` | C1, C2 | RULE-033/237, 084, 139, 144, 190 |
| `/kontrollpanel/statisk-innhold` | C4 | RULE-296, RULE-133 |
| `/kontrollpanel/artikler` | C5 | RULE-096, 182, 266 (fixed) |
| `/kontrollpanel/sponsorer` | C6 | RULE-189 |
| `/kontrollpanel/arrangementer` | C8 | RULE-085, 188 |

`/filer/{key}` uses the domain's `servingHeaders` verbatim. Only JPEG, PNG, WebP, GIF and PDF are served inline; everything else is an attachment. Every response carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'` and `Cache-Control: public, max-age=31536000, immutable`. Error responses also carry `nosniff` and the sandbox CSP.

The control panel is at stub depth: one list plus one create (or edit) form per capability. A staff listing of draft articles is not built: the domain has no query for it yet (`ArticleRepository.listPublished` only). Publish or unpublish a draft by id.

## Env and bindings

The Worker reads these names; `src/server/env.ts` types them. `alchemy.run.ts` asserts at compile time that the bindings it declares match. A negative control (renaming one binding) fails the type check.

| Binding | Kind | Notes |
| --- | --- | --- |
| `DEPLOYMENT` | var | `production` on stage `production`, else `preview` |
| `HYPERDRIVE` | Hyperdrive | Neon origin, **query caching disabled** |
| `PUBLIC_FILES` | R2 bucket | `vp-public-files`, EU jurisdiction, no public access |
| `CONTACT_RATE_LIMIT` | Rate Limiting binding | 5 posts / 60 s per client IP |
| `TURNSTILE_SITE_KEY` | var | `${TURNSTILE_SITE_KEY}` at deploy |
| `TURNSTILE_SECRET_KEY` | secret | `${TURNSTILE_SECRET_KEY}` at deploy |
| `SEND_EMAIL` | `send_email` | **production only**; sender restricted to `MAIL_FROM` |
| `MAIL_FROM` | var | production only, `${MAIL_FROM}` |
| `SLACK_WEBHOOK_URL` | secret | production only, `${SLACK_WEBHOOK_URL}` |

Deploy-time placeholders (`alchemy.run.ts`): `NEON_HOST`, `NEON_DATABASE`, `NEON_USER`, `NEON_PASSWORD`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, and, for production, `MAIL_FROM` and `SLACK_WEBHOOK_URL`. Shared Worker settings (compatibility date, entry, bucket name, rate limit, cron) live once in `worker.config.ts`, which both `alchemy.run.ts` and `vite.config.ts` import.

**Do not run `alchemy deploy`** without operator authority. The file only has to type-check (`vp check`).

### Not covered by Alchemy

- Neon itself (project and branch) is not declared here. Architecture §4 leaves the choice between Alchemy's Neon module and `neonctl` to slice 0000.
- No custom domain or zone route is declared yet: production hostname cut-over is a separate decision.

## Local development (devenv)

Run everything inside devenv from the monorepo root. The devenv services (PostgreSQL 17, MySQL 8.4) must be up (`devenv up -d`), and the schema must be migrated (`packages/db`: `bun run db:migrate`).

```sh
devenv shell -- bash -c 'cd apps/web && bunx vp dev --port 3000'
devenv shell -- bash -c 'cd apps/web && bunx vp test'
devenv shell -- bash -c 'cd apps/web && bunx vp check'
devenv shell -- bash -c 'cd apps/web && bunx vp build'
```

`vite.config.ts` configures the Cloudflare Vite plugin inline (there is no `wrangler.jsonc`):

- **`vp dev` = the `local` deployment.** Hyperdrive's `localConnectionString` is `DATABASE_URL` (Miniflare needs a user and password in the URL; devenv's trust auth ignores the placeholder password). R2 and the rate limiter are simulated. There is no `send_email`, so outbox messages go to the capture sink and the Worker log. Set `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` to Cloudflare's published test keys to try the contact form. Without them, every contact post is rejected (RULE-167 fails closed).
- **A standalone `vp build` is labelled `preview`** (no test actor, no secrets in `dist/server/wrangler.json`). Real deployments go through Alchemy, which injects its own Cloudflare plugin (`ALCHEMY_CLOUDFLARE_VITE_INJECTED=1`); this config's plugin then stands down.
- Under `vp test` (Vitest 5, Node) no Vite plugins load. The tests run in Node with in-memory Layers (`test/support/memory.ts`). workerd tests cannot run under Vite+ (architecture, Checkpoint 2: `vitest-pool-workers` needs Vitest 4).

## Tests

| File | What it proves |
| --- | --- |
| `test/errors.test.ts` | the error table (404/403/409/400, 422 form, 429), serializable failures, defects reject, AbortSignal interrupts |
| `test/sandbox.test.ts` | the production sender Layer fails to build for `preview`/`local`; capture sink; test actor only in `local` |
| `test/publicFiles.test.ts` | RULE-290: `/filer` header policy, unregistered key → 404, no paths |
| `test/redirects.test.ts` | legacy aliases → 301, legacy file paths → `/filer/{key}`, traversal never looked up |
| `test/contact.test.ts` | RULE-167: no or invalid token → rejected, no outbox rows, no commit; RULE-156; RULE-249; rate limit |
| `test/news.test.ts` | RULE-267 (draft → `notFound` at the loader), RULE-326 (35 → 10/10/10/5) |
| `test/outboxDelivery.test.ts` | delivered, ids-only claim, backoff, dead after `MAX_ATTEMPTS` |

Real-database behaviour (transactions, constraints, `FOR UPDATE SKIP LOCKED`) is tested in `packages/db`.

## What slice 0000 must still prove on a deployed Worker

These checks run only on a deployed preview (workerd + Hyperdrive + Neon). Nothing here proves them:

1. `DatabaseLive` (`@effect/sql-pg` 4.0.5 over `node:net` + `prepare: false`) connects and selects through Hyperdrive. Drizzle `effect-postgres` works on top of it.
2. A `transactional` command commits; a typed failure and an interruption (request abort) roll back; a nested savepoint works.
3. `INSERT … ON CONFLICT … RETURNING` and unique-violation classification work through Hyperdrive.
4. `timestamptz`, `date`, `jsonb` and `numeric` round-trip.
5. 20 concurrent requests, each building its own per-request Layer, stay within Hyperdrive's pool and the Worker CPU budget.
6. `sanitize-html` runs in workerd against the XSS corpus.
7. A timed bcrypt `$2y$12$` verification (Phase 2 dependency).
8. Web-specific: `ctx.waitUntil` delivery completes after the response; the cron `scheduled` sweep runs; `send_email` delivers in production only; Turnstile siteverify works with real keys; the Rate Limiting binding limits per IP; R2 streaming through `/filer/{key}` works with the `nosniff` and sandbox headers; Workers Logs show defect logs.

If 1–5 fail, switch to the fallback in architecture §4 before spec 0001 is frozen.

## Registered exceptions

| Id | Scope | Reason | Retirement trigger |
| --- | --- | --- | --- |
| WEB-001 | `src/server/fileStore.ts`: `object.body as unknown as ReadableStream<Uint8Array>` | `@cloudflare/workers-types` and lib.dom declare `ReadableStream` separately; it is the same runtime object. Verified by the deployed `/filer` check (slice 0000 item 8). | workers-types and lib.dom types unify, or Alchemy's typed R2 client is adopted for the binding |
| WEB-002 | `Effect.promise` around R2, `send_email` (`tryPromise`), Rate Limiting and Web Crypto | Boundary adapters for foreign Promise APIs. Effect has no Workers bindings of its own. R2 or rate-limit rejections are defects because the domain's `FileStore` contract has no error channel. | Alchemy's Effect-native binding clients become usable from a TanStack Start Worker entry |
| WEB-003 | Server-function `.validator(formData)` throws `Error` on non-`FormData` input | TanStack's validator contract is throw-based; the domain decodes the fields. | TanStack Start accepts an Effect Schema (Standard Schema) for `FormData` input |

No lint or type suppressions are used.
