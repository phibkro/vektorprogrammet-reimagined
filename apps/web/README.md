# @vektorprogrammet/web

The one deployable: TanStack Start on one Cloudflare Worker. Public pages, `/kontrollpanel`, server functions (the only write path besides the cron), legacy 301 redirects, `/filer/{key}`, the outbox sweep and the semester job. It holds no business rules; those live in `@vektorprogrammet/domain` and the database in `@vektorprogrammet/db`. This README covers the runtime model, the env and bindings, local development, the tests (Node and browser), and what slice 0000 left unproven.

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
                                     → ctx.waitUntil(runSemesterJob(env))       (semester job: the current and the next semester)
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

   It returns a serializable `Outcome` (`lib/outcome.ts`). A server function's reply carries the failure's status as its HTTP status (`server/outcomeStatus.ts`, a function middleware registered in `src/start.ts`), so a refused call is a real 403 or 409 on the wire; the client still decodes the `Outcome` body. Loaders turn a 404 into TanStack's `notFound()` (`pageData`). Defects are logged with their cause and rethrown, so the framework answers 500.

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
| `/kontrollpanel` + `avdelinger`, `semestre`, `linjer` | C1, C2 | RULE-033/237, 084, 139 (spec 0001); `semestre` is a list only, no create form (spec 0003, RULE-144 and 190 retired) |
| `/kontrollpanel/statisk-innhold` | C4 | RULE-296, RULE-133 |
| `/kontrollpanel/artikler` | C5 | RULE-096, 182, 266 (fixed) |
| `/kontrollpanel/sponsorer` | C6 | RULE-189 |
| `/kontrollpanel/arrangementer` | C8 | RULE-085, 188 |

`/filer/{key}` uses the domain's `servingHeaders` verbatim. Only JPEG, PNG, WebP, GIF and PDF are served inline; everything else is an attachment. Every response carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'` and `Cache-Control: public, max-age=31536000, immutable`. Error responses also carry `nosniff` and the sandbox CSP.

Departments and fields of study (spec 0001) have their full control-panel journey: a table, a dialog form per create or edit, field-level messages, and a form-level alert for a refusal. A team leader sees and changes only their own department's fields of study. Semesters (spec 0003) have no form: the list shows them newest first with the current one marked. The other control-panel pages are at stub depth: one list plus one create (or edit) form per capability. A staff listing of draft articles is not built: the domain has no query for it yet (`ArticleRepository.listPublished` only). Publish or unpublish a draft by id.

## Env and bindings

The Worker reads these names; `src/server/env.ts` types them. `alchemy.run.ts` asserts at compile time that the bindings it declares match. A negative control (renaming one binding) fails the type check.

| Binding | Kind | Notes |
| --- | --- | --- |
| `DEPLOYMENT` | var | `production` on stage `production`, else `preview` |
| `HYPERDRIVE` | Hyperdrive | Neon origin, **query caching disabled** |
| `PUBLIC_FILES` | R2 bucket | `vp-public-files` on production, `vp-public-files-<stage>` elsewhere; EU jurisdiction, no public access |
| `CONTACT_RATE_LIMIT` | Rate Limiting binding | 5 posts / 60 s per client IP |
| `TURNSTILE_SITE_KEY` | var | production: `${TURNSTILE_SITE_KEY}` at deploy; elsewhere Cloudflare's always-pass test key |
| `TURNSTILE_SECRET_KEY` | secret | production: `${TURNSTILE_SECRET_KEY}` at deploy; elsewhere the always-pass test secret |
| `SEND_EMAIL` | `send_email` | **production only**; sender restricted to `MAIL_FROM` |
| `MAIL_FROM` | var | production only, `${MAIL_FROM}` |
| `SLACK_WEBHOOK_URL` | secret | production only, `${SLACK_WEBHOOK_URL}` |

Deploy-time env (`alchemy.run.ts`): `NEON_HOST`, `NEON_DATABASE`, `NEON_USER`, `NEON_APP_PASSWORD`, and, for production only, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `MAIL_FROM` and `SLACK_WEBHOOK_URL`. Shared Worker settings (compatibility date, entry, bucket naming, Turnstile test keys, rate limit, cron, base stage) live once in `worker.config.ts`, which both `alchemy.run.ts` and `vite.config.ts` import.

### Stages and previews (spec 0002)

| Stage | What it is | Database | Deployed by |
| --- | --- | --- | --- |
| `main` | the base Worker, built from `main`; parent of every Preview; runs the cron (outbox sweep and semester job) | Neon `dev`, the importer's **fake** fixture | `.github/workflows/preview.yml` on push to `main` |
| `pr-<n>` | a [Cloudflare Worker Preview](https://developers.cloudflare.com/workers/previews/) of `main`: own URL, bindings, Hyperdrive config and R2 bucket; no crons | Neon `preview/pr-<n>`, forked from `dev` and migrated before the deploy; expires 14 days after the last push | the same workflow on every push to a pull request; destroyed when it closes |
| `production` | the production deployment (not deployed yet) | Neon `production` | operator only |

Base and previews are the `preview` deployment: no mail or Slack binding, and no test actor, so the control panel refuses every staff write (403). Preview URLs are public; they serve fake data only. A Preview runs no cron, so its semester rows are the ones its Neon branch forked from `dev`, where the base stage's cron wrote them. If the current semester has no row there yet, the Semestre and Arrangementer pages say so and write nothing.

Deploy a stage by hand (base example; `CI` is unset because Alchemy reads only environment credentials when `CI` is set):

```sh
SECRETSPEC_REASON="deploy stage main" devenv shell -- secretspec run -- env -u CI \
  tools/with-neon-env.sh app bash -c 'cd apps/web && bunx alchemy deploy --stage main --profile production --yes'
```

CI secrets: `CLOUDFLARE_API_TOKEN` is the account-owned token `vektorprogrammet-reimagined-ci` (Workers Scripts Write, Hyperdrive Write, Workers R2 Storage Write, Secrets Store Write, Account Settings Read, Workers Tail Read), minted with the `admin` profile's token-management token and written with `gh secret set` from stdin; `CLOUDFLARE_ACCOUNT_ID`; `NEON_APP_PASSWORD` (from SecretSpec). Neon's GitHub integration owns `NEON_API_KEY` and the `NEON_PROJECT_ID` variable. Rotate the Cloudflare token by creating a new one with the same permission groups, setting the secret, and deleting the old token.

### Not covered by Alchemy

- Neon branches come from Neon's GitHub actions (pull requests) and from the project itself (`dev`, `production`), not from `Neon.Branch`: drizzle-kit owns the migrations, and a branch must be migrated before the Worker that reads it is deployed.
- No custom domain or zone route is declared yet: production hostname cut-over is a separate decision.

## Local development (devenv)

Run everything inside devenv from the monorepo root. The devenv services (PostgreSQL 18, MySQL 8.4) must be up (`devenv up -d`), and the schema must be migrated (`packages/db`: `bun run db:migrate`).

```sh
devenv shell -- bash -c 'cd apps/web && bunx vp dev --port 3000'
devenv shell -- bash -c 'cd apps/web && bunx vp test'
devenv shell -- bun run e2e   # the browser tests; see "Browser tests" below
devenv shell -- bash -c 'cd apps/web && bunx vp check'
devenv shell -- bash -c 'cd apps/web && bunx vp build'
```

`vite.config.ts` configures the Cloudflare Vite plugin inline (there is no `wrangler.jsonc`):

- **`vp dev` = the `local` deployment.** Hyperdrive's `localConnectionString` is `DATABASE_URL` (Miniflare needs a user and password in the URL; devenv's trust auth ignores the placeholder password). R2 and the rate limiter are simulated. There is no `send_email`, so outbox messages go to the capture sink and the Worker log. Set `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` to Cloudflare's published test keys to try the contact form. Without them, every contact post is rejected (RULE-167 fails closed).
- **A standalone `vp build` is labelled `preview`** (no test actor, no secrets in `dist/server/wrangler.json`). Real deployments go through Alchemy, which injects its own Cloudflare plugin (`ALCHEMY_CLOUDFLARE_VITE_INJECTED=1`); this config's plugin then stands down.
- Under `vp test` (Vitest 5, Node) no Vite plugins load. The tests run in Node with in-memory Layers (`test/support/memory.ts`). workerd tests cannot run under Vite+ (architecture, Checkpoint 2: `vitest-pool-workers` needs Vitest 4).
- **Semesters in `vp dev`.** No page creates a semester (spec 0003). Run the cron once and the current and the next semester exist: `curl http://localhost:3000/cdn-cgi/handler/scheduled`. It also runs the outbox sweep. The browser tests do this for you.

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
| `test/organisationPanel.test.ts` | spec 0001: the departments, semesters and fields-of-study programs a server function runs: create, edit, refusals (repeated city, another department's field of study), what the views return; spec 0003: the semester views are reads (a missing row stays missing and is shown as such) |
| `test/readsNeverWrite.postgres.test.ts` | spec 0003, falsifier 3 (real PostgreSQL): every read program behind a `runQuery` call site (public pages, control-panel views, `/filer/{key}`, the legacy file redirect) runs as anonymous, admin and team leader through a database role with `SELECT` only, on empty and on seeded tables; a negative control (a read that writes) dies in the same harness; a source scan keeps the list of read paths complete and shows that no create-semester command or server function exists |
| `e2e/journey.spec.ts` | specs 0001 and 0003 in a real browser (below): steps 1 to 4 and falsifier 5 |

Real-database behaviour (transactions, constraints, `FOR UPDATE SKIP LOCKED`) is tested in `packages/db`.

## Browser tests

`bun run e2e` (from the repository root or from `apps/web`, inside devenv) runs the journey (specs 0001 and 0003) in a real browser, on migrated data. One Effect program, `e2e/run.ts`, owns everything the run starts in a single scope and releases it in reverse order on success, failure and Ctrl-C:

```
disposable PostgreSQL database (migrated, filled by the real importer)  →  vp dev on a free port  →  playwright test
```

- **Database:** `vp_db_test_<random>` on the devenv server (`TEST_DATABASE_ADMIN_URL`), from `@vektorprogrammet/db/testing`: the one migrated-disposable-database helper that `packages/db`'s tests and the importer's round trip use too. It is created, migrated with `packages/db`'s generated `drizzle/` migrations, and then filled by `tools/import`'s `import:fixture` script: the real importer pipeline on the importer's fake legacy fixture (a throwaway MySQL database, dropped again). The data is therefore migrated data with the importer's own quirks: the fixture's third department is quarantined (an invalid e-mail address), five duplicate semester rows are collapsed to two, and the orphan fields of study are left out. The database is dropped (forcibly) at the end; the developer's `vektorprogrammet` database is never touched. It needs the devenv MySQL service, as the importer's own tests do.
- **App:** the real `vp dev` (the `local` deployment: the test actor chosen by the `vp-test-actor` cookie, a simulated R2 and rate limiter) with `DATABASE_URL` pointing at that database. The harness waits for `http://localhost:<port>` (Vite binds `localhost`, which is `::1` on some hosts), then runs the Worker's `scheduled` handler once (`GET /cdn-cgi/handler/scheduled`, which the Cloudflare Vite plugin forwards to it), so the semester job has written the current and the next semester, and fetches the four control-panel pages once, so the server has compiled them before the browser asks.
- **Browser:** Playwright 1.63.0 driving the Chromium that devenv provides. `devenv.nix` sets `PLAYWRIGHT_BROWSERS_PATH` to a Chromium-only build of nixpkgs' `playwright-driver.browsers` (no Firefox or WebKit, which keeps the closure small) and `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS`. Playwright never downloads a browser.
- **Specs:** `e2e/journey.spec.ts` is one serial story over one database (`workers: 1`). Each test selects its actor with the cookie, finds elements by role and label as a person reads the page, and reads database effects back through typed probes (`e2e/support/probes.ts`, Effect Schema decoded). The refusals are asserted on the HTTP status the server sent (403, 409), not only on the message the page shows. Falsifier 5 changes a hidden form field in the browser (the field of study's id, then the department id) and expects a 403 and no change in the database. Step 2 (spec 0003) opens the Semestre page: the current and the next semester are listed because the harness ran the cron once, there is no create form, and opening the page changes no row.

**Why `@playwright/test` and not Vitest browser mode.** Vitest's browser mode runs the test code inside the page and serves the module graph itself. This journey needs the opposite: a separately started application, real HTTP cookies, real server-function round trips, and the status of each response, observed from outside. Playwright's own runner does exactly that; Vitest's Playwright provider would add a second runner and its page-side execution model for no gain here.

**Why exactly 1.63.0.** The browsers come from nixpkgs (`playwright-driver` 1.63.0, Chromium build 1243). A different `@playwright/test` looks for a different browser build and fails at launch, so the catalog pins `@playwright/test`, `playwright` and `playwright-core` to 1.63.0, `overrides` keeps the two inner packages on that pin, and Renovate does not bump them. Move them together with the nixpkgs pin in `devenv.lock`.

**Check the machine first.** A run starts Vite, workerd and Chromium. Look at CPU load and `MemAvailable` before starting it, and do not start a second one beside it. It is not part of `bun run ready`, which stays fast; CI runs it.

## What slice 0000 proved, and what it left unproven on a deployed Worker

These checks run only on a deployed preview (workerd + Hyperdrive + Neon). Slice 0000 ran items 1–7 there and they pass (`docs/specs/0000-results.md`, final run from the committed tree). Item 8 was not part of slice 0000 and is still unproven:

1. `DatabaseLive` (`@effect/sql-pg` 4.0.5 over `node:net` + `prepare: false`) connects and selects through Hyperdrive. Drizzle `effect-postgres` works on top of it.
2. A `transactional` command commits; a typed failure and an interruption (request abort) roll back; a nested savepoint works.
3. `INSERT … ON CONFLICT … RETURNING` and unique-violation classification work through Hyperdrive.
4. `timestamptz`, `date`, `jsonb` and `numeric` round-trip.
5. 20 concurrent requests, each building its own per-request Layer, stay within Hyperdrive's pool and the Worker CPU budget.
6. `sanitize-html` runs in workerd against the XSS corpus.
7. A timed bcrypt `$2y$12$` verification (Phase 2 dependency).
8. Web-specific: `ctx.waitUntil` delivery completes after the response; the cron `scheduled` handler runs the outbox sweep and the semester job (spec 0003: the first deployed run of the semester job is the check that the base stage `main` holds the current and the next semester); `send_email` delivers in production only; Turnstile siteverify works with real keys; the Rate Limiting binding limits per IP; R2 streaming through `/filer/{key}` works with the `nosniff` and sandbox headers; Workers Logs show defect logs.

Slice 0000 did not need the architecture §4 fallback. Its verdict holds on one condition: `enable_request_signal` stays in `worker.config.ts`.

## Registered exceptions

| Id | Scope | Reason | Retirement trigger |
| --- | --- | --- | --- |
| WEB-001 | `src/server/fileStore.ts`: `object.body as unknown as ReadableStream<Uint8Array>` | `@cloudflare/workers-types` and lib.dom declare `ReadableStream` separately; it is the same runtime object. Verified by the deployed `/filer` check (slice 0000 item 8). | workers-types and lib.dom types unify, or Alchemy's typed R2 client is adopted for the binding |
| WEB-002 | `Effect.promise` around R2, `send_email` (`tryPromise`), Rate Limiting and Web Crypto | Boundary adapters for foreign Promise APIs. Effect has no Workers bindings of its own. R2 or rate-limit rejections are defects because the domain's `FileStore` contract has no error channel. | Alchemy's Effect-native binding clients become usable from a TanStack Start Worker entry |
| WEB-003 | Server-function `.validator(formData)` throws `Error` on non-`FormData` input | TanStack's validator contract is throw-based; the domain decodes the fields. | TanStack Start accepts an Effect Schema (Standard Schema) for `FormData` input |

No lint or type suppressions are used.
