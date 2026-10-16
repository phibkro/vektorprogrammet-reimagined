# @vektorprogrammet/web

The one deployable: TanStack Start on one Cloudflare Worker. The public site (spec 0005: pages ported from mono-web, with their texts, FAQ, news and sponsors read from the CMS), `/kontrollpanel`, server functions (the only write path besides the cron), legacy 301 redirects, `/filer/{key}`, the outbox sweep and the semester job. It holds no business rules; those live in `@vektorprogrammet/domain` and the database in `@vektorprogrammet/db`; the editors' CMS is the separate Worker `apps/cms`. This README covers the runtime model, the public site, the env and bindings, local development, the tests (Node and browser), and what slice 0000 left unproven.

## Runtime model

```
request ─► src/server.ts  fetch
             ├─ legacy alias (/om, /bedrifter, /faq, /omvektor → /om-oss; /artikkel/{slug} → /nyhet/{slug})  → 301   (server/redirects.ts, one table)
             ├─ legacy file path (Offentlige filer/…, images/…)         → 301 /filer/{key} via PublicFileRepository.findByLegacyPath
             └─ TanStack Start handler, context = { env, ctx }
                  ├─ CSRF middleware (src/start.ts): server functions + every non-GET page request
                  ├─ server functions (src/functions/*.functions.ts)
                  ├─ server routes: /filer/$key (GET), /kontakt + /kontakt/$department (POST, no-JS form), /kontakt/avdeling/$id (GET → 301)
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
   - `CmsClient` (`packages/cms-client`) over `fetch` to `CMS_URL`, authorised with the read-only `CMS_TOKEN`: the public pages' texts, FAQ, news and sponsors
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
- **Actor** (Phase 1 has no auth): `Anonymous` everywhere, except `local`, where the `vp-test-actor` cookie selects a fixed test actor (`admin` (default), `teamLeader`, or `anonymous`). Switch it on `/kontrollpanel` (the overview, and the not-signed-in page; the switch is shown only in a `local` deployment). Outside `local`, every staff command is `Forbidden`.

### Routes

| Path | Capability | Rules |
| --- | --- | --- |
| `/` | C3 | RULE-331 (front-page news), RULE-119 (admission state); the tagline is the CMS text `home-tagline` |
| `/om-oss`, `/assistenter`, `/team`, `/team/{department}`, `/foreldre`, `/skoler` | C4 | the CMS's texts and FAQ in mono-web's layout; `/om`, `/bedrifter`, `/faq` and `/omvektor` answer 301 to `/om-oss` |
| `/nyheter`, `/nyheter?avdeling={department}&side=N` | C5 | RULE-326, RULE-267 |
| `/nyhet/{slug}` | C5 | RULE-267 (draft → 404) |
| `/kontakt`, `/kontakt/{department}` (GET + no-JS POST → 303 / 422), `/kontakt/avdeling/{id}` (301 to the department's page) | C10 | RULE-156, 167, 249; per-IP rate limit |
| `/filer/{key}` | C11 | RULE-290 replacement |
| `/kontrollpanel` + `avdelinger`, `semestre`, `linjer` | C1, C2 | RULE-033/237, 084, 139 (spec 0001); `semestre` is a list only, no create form (spec 0003, RULE-144 and 190 retired) |
| `/kontrollpanel/arrangementer` | C8 | RULE-085, 188 |

`/filer/{key}` uses the domain's `servingHeaders` verbatim. Only JPEG, PNG, WebP, GIF and PDF are served inline; everything else is an attachment. Every response carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'` and `Cache-Control: public, max-age=31536000, immutable`. Error responses also carry `nosniff` and the sandbox CSP.

Departments and fields of study (spec 0001) have their full control-panel journey: a table, a Sheet form per create or edit, field-level messages, and a form-level alert for a refusal. A team leader sees and changes only their own department's fields of study, and on another department's row gets its details (a read-only Sheet), not an edit form. Semesters (spec 0003) have no form: the list shows them newest first with the current one marked. Events have a table and one Sheet form. Static texts, articles and sponsors have no control-panel page since spec 0005: the editors work in the CMS (`apps/cms`).

### The control panel shell (spec 0004)

`/kontrollpanel` is a dashboard that owns the whole page: the route sets `staticData.ownsPage`, so the root layout renders no public header or footer around it. It has a shadcn Sidebar (`variant="inset"`, `collapsible="icon"`, an off-canvas Sheet under 768 px) of the sections the actor may use, a header with the sidebar toggle and breadcrumbs, and the page in the main area. Every create, edit and inspect flow opens in a right-hand Sheet (`components/panel/panelSheets.tsx`). Saving reloads the route's data and closes the Sheet, so the table behind it already shows the change. Escape, Cancel and the close button close it, and focus returns to the control that opened it.

What an actor sees is computed on the server from the domain's capability function, never from a role:

| What | Where | Asks |
| --- | --- | --- |
| the sidebar's sections | `server/shell.ts`: a section lists the capabilities its page exercises, and is offered to an actor who holds one (a section that lists none is for any staff member) | `authorize` |
| a page's controls: the create button, each row's edit form, the departments an event form offers | the page's view in `server/panel.ts` (`canCreate`, `canEdit`, `canManage`, `departments`) | `authorize` |
| the refusal | each command's `requireCapability` | `authorize` |

`authorize` (`packages/domain/src/shared/capabilities.ts`) is the one decision table. A control the actor lacks is not in the DOM at all (not hidden, not disabled). Hiding is presentation: a forged request for a hidden capability still gets 403 and changes nothing (`e2e/journey.spec.ts` falsifier 5, `e2e/shell.spec.ts` falsifier 3). `test/shell.test.ts` is the edge between view and command: every control is shown exactly when its command would not refuse the actor, so a role check added to a page, or a wrong capability on a control, fails it.

A visitor who is not signed in gets a plain "Ikke innlogget" page: no sidebar, no navigation, no link to a control-panel page. The public header and footer have no control-panel link for anyone; once sign-in exists (Phase 2) the same function decides whether a staff member gets one. The sidebar's open or collapsed state is not kept across a reload.

### The public site (spec 0005)

Every public page is a TanStack Start route ported from mono-web's homepage (`apps/homepage`, commit `2aa6ce97`): Hjem, Om oss, Assistenter, Team, Foreldre, Skoler, Nyheter with its article page, and Kontakt. The pictures (`public/images/`) and the palette (the `vektor-*` tokens in `src/styles.css`) are mono-web's, and its Radix-based shadcn components are the `base-nova` (Base UI) ones the control panel already uses, so the app has one primitive library. Mono-web's homepage was a synthetic development build (`DEV CONTENT` banners, invented statistics and sponsors, and a team API behind it): its layout is ported, its content is not.

| What a page shows | Where it comes from |
| --- | --- |
| a text (`about-header`, `home-tagline`, …) | the CMS collection `texts`, one entry per slot, by slug. `src/lib/textSlots.ts` names each page's slots; `test/textSlots.test.ts` checks them against the default copy in `apps/cms/seed/seed.json`. A slot with no published entry renders nothing |
| the FAQ of `/assistenter` and `/team` | the CMS collection `faq` (`page`, `position`) |
| news | the CMS collection `news`, published entries only: sticky first on the front page (RULE-331), ten a page (RULE-326), filtered by a department's city |
| the sponsors in the footer | the CMS collection `sponsors`: large, medium, small, then by name |
| the teams of `/team` | the CMS collection `teams`; empty until an editor adds one, because the seed holds no fake people |
| departments, the admission state, the contact targets | PostgreSQL (`@vektorprogrammet/db`); the contact form is the existing C10 command |

The pages read the CMS in `server/site/pages.ts`, in the same per-request program as their database reads. A text is Portable Text, rendered by `components/site/portableTextView.tsx` as the design's elements: a block is data, a link is rendered only for an address the page may link to (RULE-133), and nothing is ever inserted as HTML. The CMS client lists published entries only (`status=published`, checked again in the client), so a token that can read drafts never makes a draft public. A CMS that cannot be reached is a 503, and a refusal or an entry that does not match its collection is a 502 (`server/errors.ts`): no page falls back to made-up content. The page theme (the light blue page, the default border) is the `.public-site` block of `src/styles.css`; it is the only place that sets element colours, because an unlayered rule would beat every Tailwind utility on the ported markup.

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
| `CMS_URL` | var | the CMS Worker's origin: the stage's own `apps/cms` Worker (a Preview reads its own pull request's CMS Preview) |
| `CMS_TOKEN` | secret | a read-only personal access token of the CMS (scope `content:read`); `${CMS_READ_TOKEN}` at deploy |

Deploy-time env (`alchemy.run.ts`): `NEON_HOST`, `NEON_DATABASE`, `NEON_USER`, `NEON_APP_PASSWORD`, the CMS's `NEON_EMDASH_USER`, `NEON_EMDASH_PASSWORD`, `EMDASH_ENCRYPTION_KEY` and `CMS_READ_TOKEN`, and, for production only, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `MAIL_FROM` and `SLACK_WEBHOOK_URL`. Shared Worker settings (compatibility date and flags, entry, bucket naming, Turnstile test keys, rate limit, cron, base stage) live once in `worker.config.ts`, which both `alchemy.run.ts` and `vite.config.ts` import. The flag `global_fetch_strictly_public` lets this Worker `fetch` the CMS Worker by URL (without it Cloudflare answers error 1042); it changes `fetch()` only, so the Hyperdrive binding is unaffected, which the first Preview confirms.

### Stages and previews (spec 0002)

| Stage | What it is | Database | Deployed by |
| --- | --- | --- | --- |
| `main` | the base Worker, built from `main`; parent of every Preview; runs the cron (outbox sweep and semester job) | Neon `dev`, the importer's **fake** fixture | `.github/workflows/preview.yml` on push to `main` |
| `pr-<n>` | a [Cloudflare Worker Preview](https://developers.cloudflare.com/workers/previews/) of `main`: own URL, bindings, Hyperdrive config and R2 bucket; no crons | Neon `preview/pr-<n>`, forked from `dev` and migrated before the deploy; expires 14 days after the last push | the same workflow on every push to a pull request; destroyed when it closes |
| `production` | the production deployment (not deployed yet) | Neon `production` | operator only |

Base and previews are the `preview` deployment: no mail or Slack binding, and no test actor, so the control panel refuses every staff write (403). Preview URLs are public; they serve fake data only. A Preview runs no cron, so its semester rows are the ones its Neon branch forked from `dev`, where the base stage's cron wrote them. If the current semester has no row there yet, the Semestre and Arrangementer pages say so and write nothing.

**The CMS Worker (spec 0005)** is declared in the same stack (`alchemy.run.ts`: `Cms` and `Web`), so it has the same two kinds of stage: the base `main` and a Worker Preview per pull request. Each has its own Hyperdrive configuration for the role `emdash_app` (cache off) and its own R2 media bucket (`vp-cms-media-<stage>`). A Preview of the web app reads its own pull request's CMS Preview through `CMS_URL`, so content stays isolated per pull request. The CMS's database is the schema `emdash` of the same Neon database, so a Preview's Neon branch carries its own CMS content, forked from `dev`; a Preview has no editor access, because EmDash's passkeys are bound to a hostname. Deploy `main` before any Preview: a Preview is a Worker Preview of the base Worker.

Deploy a stage by hand (base example; `CI` is unset because Alchemy reads only environment credentials when `CI` is set):

```sh
SECRETSPEC_REASON="deploy stage main" devenv shell -- secretspec run -- env -u CI \
  tools/with-neon-env.sh app bash -c 'cd apps/web && bunx alchemy deploy --stage main --profile production --yes'
```

CI secrets: `CLOUDFLARE_API_TOKEN` is the account-owned token `vektorprogrammet-reimagined-ci` (Workers Scripts Write, Hyperdrive Write, Workers R2 Storage Write, Secrets Store Write, Account Settings Read, Workers Tail Read), minted with the `admin` profile's token-management token and written with `gh secret set` from stdin; `CLOUDFLARE_ACCOUNT_ID`; `NEON_APP_PASSWORD` (from SecretSpec). Neon's GitHub integration owns `NEON_API_KEY` and the `NEON_PROJECT_ID` variable. Rotate the Cloudflare token by creating a new one with the same permission groups, setting the secret, and deleting the old token. The CMS adds `NEON_EMDASH_PASSWORD` (the role `emdash_app`; `NEON_EMDASH_USER` is a workflow variable), `EMDASH_ENCRYPTION_KEY` (from `emdash secrets generate`) and `CMS_READ_TOKEN` (a personal access token with `content:read`, created in the EmDash admin after the first base deploy).

### Not covered by Alchemy

- Neon branches come from Neon's GitHub actions (pull requests) and from the project itself (`dev`, `production`), not from `Neon.Branch`: drizzle-kit owns the migrations, and a branch must be migrated before the Worker that reads it is deployed.
- No custom domain or zone route is declared yet: production hostname cut-over is a separate decision.
- EmDash's own setup is done in its admin, not by Alchemy: the first visitor to an empty `emdash` schema becomes its administrator, who registers a passkey and creates the read-only token that `CMS_READ_TOKEN` carries (`apps/cms/README.md`).

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
- **The CMS in `vp dev`.** The content pages read the CMS named by `CMS_URL` with `CMS_TOKEN`. Start `apps/cms` first (`apps/cms/README.md`: `bun run dev` listens on 4321), take a token from `POST http://localhost:4321/_emdash/api/setup/dev-bypass?token=1`, and run `CMS_URL=http://localhost:4321 CMS_TOKEN=… bunx vp dev`. Without a reachable CMS the content pages answer 503 and the rest of the app works. `global_fetch_strictly_public` does not stop `vp dev` from fetching a `localhost` CMS (the browser tests rely on it).

## Tests

| File | What it proves |
| --- | --- |
| `test/errors.test.ts` | the error table (404/403/409/400, 422 form, 429), serializable failures, defects reject, AbortSignal interrupts |
| `test/sandbox.test.ts` | the production sender Layer fails to build for `preview`/`local`; capture sink; test actor only in `local` |
| `test/publicFiles.test.ts` | RULE-290: `/filer` header policy, unregistered key → 404, no paths |
| `test/redirects.test.ts` | legacy aliases → 301, legacy file paths → `/filer/{key}`, traversal never looked up |
| `test/contact.test.ts` | RULE-167: no or invalid token → rejected, no outbox rows, no commit; RULE-156; RULE-249; rate limit |
| `test/outboxDelivery.test.ts` | delivered, ids-only claim, backoff, dead after `MAX_ATTEMPTS` |
| `test/organisationPanel.test.ts` | spec 0001: the departments, semesters and fields-of-study programs a server function runs: create, edit, refusals (repeated city, another department's field of study), what the views return; spec 0003: the semester views are reads (a missing row stays missing and is shown as such) |
| `test/readsNeverWrite.postgres.test.ts` | spec 0003, falsifier 3 (real PostgreSQL): every read program behind a `runQuery` call site (public pages, control-panel views, `/filer/{key}`, the legacy file redirect) runs as anonymous, admin and team leader through a database role with `SELECT` only, on empty and on seeded tables; a negative control (a read that writes) dies in the same harness; a source scan keeps the list of read paths complete and shows that no create-semester command or server function exists |
| `test/shell.test.ts` | spec 0004, falsifier 6: the sidebar follows the actor's capabilities (the role and the department each change what it lists), the shell view carries it (and the test-actor switch only in `local`), and every page control (department create and edit, fields of study, the departments an event form offers) is shown exactly when its command would not refuse the actor |
| `test/site.test.ts` | spec 0005: the public pages' programs over an in-memory CMS: RULE-267 (a draft or an unknown slug is 404, drafts are not in the list), RULE-326 (newest first, ten a page, a page past the end is empty), RULE-331 and RULE-119 on the home page, the text slots, the footer's sponsor order, the team and contact pages, a department's URL segment (Å is `aa`) |
| `test/portableTextView.test.tsx` | RULE-133: a `javascript:` address is plain text, only http(s), mailto and tel addresses are links, raw HTML never reaches the page; every block type the design renders |
| `test/navigation.test.ts` | the header's active tab, and the search of the news and contact pages |
| `test/textSlots.test.ts` | every text slot a page shows has default copy in the CMS seed, and the copy is valid content for the client |
| `test/panel.test.ts` | RULE-033 through the panel's view program (the semester of the Oslo calendar month); the read writes no row |
| `e2e/journey.spec.ts` | specs 0001 and 0003 in a real browser (below), in Sheets: steps 1 to 4 and falsifier 5 |
| `e2e/shell.spec.ts` | spec 0004 in a real browser (below): falsifiers 1 to 5, per actor |
| `e2e/public.spec.ts` | spec 0005 in a real browser against the real CMS (below): every page, an edit published without a deploy, the contact form's transaction, the 301 redirects |

Real-database behaviour (transactions, constraints, `FOR UPDATE SKIP LOCKED`) is tested in `packages/db`.

## Browser tests

`bun run e2e` (from the repository root or from `apps/web`, inside devenv) runs the browser tests in a real browser, on migrated data: the journey (specs 0001 and 0003) and the dashboard (spec 0004). One Effect program, `e2e/run.ts`, owns everything the run starts in a single scope and releases it in reverse order on success, failure and Ctrl-C. Arguments go to Playwright (`bun run e2e shell.spec.ts`, `bun run e2e -g "falsifier 5"`):

```
disposable PostgreSQL database (migrated, filled by the real importer)  →  the CMS (`astro dev`, its seed copy, the importer's fixture twice)  →  vp dev on a free port  →  playwright test
```

- **Database:** `vp_db_test_<random>` on the devenv server (`TEST_DATABASE_ADMIN_URL`), from `@vektorprogrammet/db/testing`: the one migrated-disposable-database helper that `packages/db`'s tests and the importer's round trip use too. It is created, migrated with `packages/db`'s generated `drizzle/` migrations, and then filled by `tools/import`'s `import:fixture` script: the real importer pipeline on the importer's fake legacy fixture (a throwaway MySQL database, dropped again). The data is therefore migrated data with the importer's own quirks: the fixture's third department is quarantined (an invalid e-mail address), five duplicate semester rows are collapsed to two, and the orphan fields of study are left out. The database is dropped (forcibly) at the end; the developer's `vektorprogrammet` database is never touched. It needs the devenv MySQL service, as the importer's own tests do.
- **App:** the real `vp dev` (the `local` deployment: the test actor chosen by the `vp-test-actor` cookie, a simulated R2 and rate limiter) with `DATABASE_URL` pointing at that database. The harness waits for `http://localhost:<port>` (Vite binds `localhost`, which is `::1` on some hosts), then runs the Worker's `scheduled` handler once (`GET /cdn-cgi/handler/scheduled`, which the Cloudflare Vite plugin forwards to it), so the semester job has written the current and the next semester, and fetches every page the specs open once, so the server has compiled them before the browser asks.
- **CMS:** the real EmDash (`apps/cms` under `astro dev` with `CMS_STANDALONE=1`) on the same database, in its schema `emdash`. The harness runs `apps/cms/db/emdash-role.sql` with `psql` (the script a deployment runs once), starts the server with a local Hyperdrive string for the role `emdash_app` and a generated `EMDASH_ENCRYPTION_KEY`, waits for `/_emdash/api/setup/status` (the first request runs EmDash's migrations and creates the collections of the seed), and calls the development bypass (`POST /_emdash/api/setup/dev-bypass?token=1`), which applies the default copy of `seed/seed.json` and mints a token. `tools/import`'s `import:fixture:cms` then moves the fixture's articles, texts and sponsors in, and runs a second time: the harness fails unless the second run creates nothing (spec 0005, falsifier 4). `vp dev` gets `CMS_URL`, `CMS_TOKEN` and Cloudflare's always-pass Turnstile keys, so the contact form is exercised with the real widget (this needs outbound network).
- **Browser:** Playwright 1.63.0 driving the Chromium that devenv provides. `devenv.nix` sets `PLAYWRIGHT_BROWSERS_PATH` to a Chromium-only build of nixpkgs' `playwright-driver.browsers` (no Firefox or WebKit, which keeps the closure small) and `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS`. Playwright never downloads a browser.
- **Specs:** `e2e/journey.spec.ts` is one serial story over one database (`workers: 1`). Each test selects its actor with the cookie, finds elements by role and label as a person reads the page, and reads database effects back through typed probes (`e2e/support/probes.ts`, Effect Schema decoded). The refusals are asserted on the HTTP status the server sent (403, 409), not only on the message the page shows. Falsifier 5 changes a hidden form field in the browser (the field of study's id, then the department id) and expects a 403 and no change in the database. Step 2 (spec 0003) opens the Semestre page: the current and the next semester are listed because the harness ran the cron once, there is no create form, and opening the page changes no row.
- **Spec 0004:** `e2e/shell.spec.ts` runs after the journey (Playwright takes the files in name order) and checks, as the administrator, a team leader of department 1 and an anonymous visitor: the sidebar lists exactly the sections the actor may use and each opens its page, and an anonymous visitor gets the not-signed-in page with no control-panel link on it or on any public page (falsifier 1); every control a capability gates is absent from the DOM for an actor without it (falsifier 2); a forged request for a capability the page does not offer gets the domain's 403 and changes nothing, while the same bytes from an administrator are accepted (falsifier 3); create and edit open in a right-hand Sheet, a saved edit shows in the table without a page reload, and Escape and Cancel return focus to the opener (falsifier 4); at 1280 px the sidebar collapses to icons and back, and at 390 px it opens as an off-canvas panel (falsifier 5). The screenshots the pull request carries are written when `E2E_SCREENSHOT_DIRECTORY` names a directory: `E2E_SCREENSHOT_DIRECTORY=$PWD/docs/specs/0004-screenshots bun run e2e shell.spec.ts`, from the repository root.
- **Spec 0005:** `e2e/public.spec.ts` runs second (files go in name order; what it must list about departments it reads from the database, because the journey changes them). Falsifier 1: each page renders its headings and texts from the CMS, the FAQ counts are the `faq` entries', the home page shows only the published article (the importer's two drafts are not news, and `/nyhet/kladd` is 404), the footer's sponsor is the CMS's, and the department tabs are the database's. Falsifier 2: a text saved in the CMS (a draft of a published entry) is not public until it is published, and after `publish` the page shows it on the next request with nothing built or deployed (`e2e/support/editor.ts` is the editor, through the REST API). Falsifier 3: a post without a Turnstile answer is 422 and queues nothing; a valid post, sent after a client-side move to another department's tab and with the real widget, queues exactly the RULE-249 messages, all with one creation instant (`enqueue` writes them in one INSERT), and no audit row. Falsifier 5: every alias, and a registered legacy file path, answers 301 with the right `Location`. The widget needs outbound network from the browser and from workerd (a fetch to Cloudflare's siteverify); `devenv.nix` exports `SSL_CERT_FILE` so that workerd has a CA bundle on NixOS.
- **Teardown and CI.** The scope closes the Playwright process, then `vp dev` (its whole process group), then drops the database. The drop goes through `withClient` (`@vektorprogrammet/db/testing`): a client with one connection, opened for that statement. Before that, the drop used an admin pool opened at the start; the pool retired its idle connection after 60 to 120 seconds and could not open another while its scope was closing, so a run longer than two minutes (the 24 tests take 2 to 3 minutes on a CI runner, one minute here) passed its tests and then never exited, silently, and the CI step hung until it was cancelled. The CI step has `timeout-minutes: 15` as a bound. To reproduce a CI run's shape locally, make a run longer than two minutes: `bun run e2e -g "falsifier 2" --repeat-each 10` takes three minutes and must exit within a second of its summary line.

**Why `@playwright/test` and not Vitest browser mode.** Vitest's browser mode runs the test code inside the page and serves the module graph itself. This journey needs the opposite: a separately started application, real HTTP cookies, real server-function round trips, and the status of each response, observed from outside. Playwright's own runner does exactly that; Vitest's Playwright provider would add a second runner and its page-side execution model for no gain here.

**Why exactly 1.63.0.** The browsers come from nixpkgs (`playwright-driver` 1.63.0, Chromium build 1243). A different `@playwright/test` looks for a different browser build and fails at launch, so the catalog pins `@playwright/test`, `playwright` and `playwright-core` to 1.63.0, `overrides` keeps the two inner packages on that pin, and Renovate does not bump them. Move them together with the nixpkgs pin in `devenv.lock`.

**Check the machine first.** A run starts Vite, workerd, the CMS's Astro server and Chromium. Look at CPU load and `MemAvailable` before starting it, and do not start a second one beside it. It is not part of `bun run ready`, which stays fast; CI runs it.

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
