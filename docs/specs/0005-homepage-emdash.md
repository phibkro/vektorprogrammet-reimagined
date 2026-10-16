# Spec 0005: The public site on Astro + EmDash

**Status:** design approved (operator, 2026-10-16: "Approve all 7"); frozen when its PR opens · **Phase:** 1 · **Depends on:** spec 0004 merged (it reshapes the content pages this spec retires) · **Source:** operator decision 2026-10-16 (brief §7 "Product direction"): "homepage doesnt need design. just use the existing design from mono-web and @vektorprogrammet/homepage can likely use astros new Emdash cms for managing its contents".

## Journey

1. **A visitor** opens the public site and sees mono-web's homepage design (`@monoweb/homepage`): Hjem, Om oss, Assistenter, Team, Foreldre, Skoler, Nyheter and Kontakt, with the departments, admission status and contact details coming from the organisation data.
2. **An editor** signs in to EmDash's admin (`/_emdash/admin`), edits a page, publishes a news article with an image and changes the sponsor list. The public site shows the change, and nobody deploys anything.
3. **A visitor** sends the contact form for a department. The message reaches that department exactly like today (RULE-156, 167, 249).
4. **Old links** (`/om`, `/bedrifter`, `/faq`, `/artikkel/{slug}`, legacy file paths) still land on the right page (301).

## Design decisions (all seven recommendations approved by the operator, 2026-10-16)

| # | Question | Recommendation | Alternative and its cost |
| --- | --- | --- | --- |
| D1 | Where does EmDash store content? | **Neon, same project, schema `emdash` owned by its own role `emdash_app`, through a Hyperdrive binding** (EmDash's documented Hyperdrive adapter). One database, one backup; every preview's Neon fork carries its own CMS content. | D1: Cloudflare's default for EmDash, but a second database per preview and a second backup story. |
| D2 | How do the two apps share one hostname? | **`apps/homepage` serves the site root; `apps/web` serves `/kontrollpanel*` (and later the member pages) through a zone route on the same domain.** Both Workers are declared in the one Alchemy stack, and each has its own base `main` and per-PR Previews. | Two hostnames (`www.` and `app.`): simpler routing, but cookies and links cross origins. |
| D3 | How does the homepage get organisation data (departments, admission open, contact targets)? | **It imports `packages/domain` + `packages/db` and reads through its own Hyperdrive binding** (no Worker-to-Worker call: a Preview's service binding reaches the _production_ Worker, Cloudflare docs). | An HTTP/RPC call to `apps/web`: a second contract to version, and it breaks preview isolation. |
| D4 | Who runs the contact command? | **The homepage runs the same domain command** (`domain/src/contact/*`: ticket + audit + outbox in one transaction) and delivers by `waitUntil`; `apps/web`'s cron sweep is the backstop. One construct, two hosts. | Post to `apps/web`: cross-origin form, same isolation problem as D3. |
| D5 | Where do legacy articles, static texts and sponsors go? | **Into EmDash collections, through EmDash's content import**, from the existing importer's reading of the legacy tables (reconciliation report kept). The Postgres content tables and their control-panel pages retire. Images wait for the file copy ("Skip for now"). | Keep them in Postgres and render them in Astro: no editor UI, the reason for EmDash is gone. |
| D6 | How do editors sign in? | **EmDash's own login (passkeys + invites) now**; Phase 2 decides whether Better Auth becomes an EmDash login provider. Passkeys are bound to a domain, so previews get seeded fake content and no editor access. | Cloudflare Access mode: SSO for editors, but a Zero Trust setup and a second identity source before Phase 2. |
| D7 | How is mono-web's design reused? | **Port its pages to Astro components with its Tailwind CSS and images; React islands (`@astrojs/react`) only where it is interactive** (tabs, accordion, forms). Its Radix components stay Radix inside those islands; the dashboard keeps Base UI. | Rewrite in Base UI: work with no visible gain on a static site. |

Out of scope: team applications (`/team/$teamId/soknad`, Phase 3), the member area, sign-in (Phase 2).

## Goal, constraints, values

- **Goal:** the public site has an editor-managed CMS and the design the operator already accepted, so content never needs a developer.
- **Constraints:** Alchemy v2 stays the one infrastructure root (`Cloudflare.Website.Astro`, `@alchemy.run/frontend-frameworks`); EmDash 1.0 (stable); Neon PostgreSQL 18; organisation data has one writer per fact (D3, D4); Worker Previews for both apps (spec 0002); fake data only on public previews.
- **Values:** no fact lives in two places: a page's text lives in EmDash, a department lives in Postgres, and the homepage reads both and owns neither.

## Falsifiers (definition of done)

1. Every page in the Journey's nav renders on the base stage and on the PR's Preview, from EmDash (texts, news, sponsors) and Postgres (departments, admission state); a page-by-page screenshot comparison with mono-web's homepage is in the PR.
2. An editor edit published in EmDash appears on the public page without a deploy (browser test against the Preview's own Neon fork).
3. The contact form creates one ticket, one audit row and one outbox row in one transaction, and the message is delivered (capture sink outside production); RULE-156/167/249 tests pass from the homepage host.
4. The importer moves the legacy fixture's articles, static texts and sponsors into EmDash with a reconciliation report (counts only), and a rerun changes nothing.
5. The legacy redirects answer 301 to the right target.
6. `apps/web` no longer serves public pages or content control-panel pages, and no dead code for them remains (knip clean).
7. CI green; both apps have a base deployment and a Preview per PR, and closing the PR removes both Previews and the Neon branch.

## Revisions

### R1 (operator, 2026-10-16): TanStack Start renders every page; EmDash runs headless

Operator: "we could also keep only tanstack start but we'd want to avoid having to hand roll our own cms", then chose "Start pages + EmDash headless". This supersedes D2, D3, D4 and D7; D1, D5 and D6 stand.

- **Pages:** all public pages are TanStack Start routes in `apps/web`, ported from mono-web's React homepage (`@monoweb/homepage`), with its CSS and images. Its Radix-based shadcn components are swapped for the `base-nova` (Base UI) equivalents already in `apps/web`, so the app keeps one primitive library.
- **CMS:** a CMS-only Astro app, `apps/cms`, hosts EmDash's admin (`/_emdash/admin`) and REST API (`/_emdash/api/`, OpenAPI 3.1) and renders no public pages. It is declared in the same Alchemy stack, with its own base `main` Worker and a Preview per PR.
- **How Start reads content:** over EmDash's REST API, with a typed client generated from `GET /_emdash/api/openapi.json` and a read-only bearer token (scoped personal access token). Worker-to-Worker `fetch` by URL needs the `global_fetch_strictly_public` compatibility flag on `apps/web` (Cloudflare error 1042 otherwise; Workers fetch docs). Each Preview of `apps/web` reads its own PR's CMS Preview, so content stays isolated per PR. The flag must not disturb the Hyperdrive binding: the first Preview checks it.
- **Organisation data and contact (D3, D4 retired):** they stay in `apps/web`, which already has them. Nothing is duplicated across hosts.
- **Falsifier changes:** falsifier 1 now means "every page renders from EmDash's API and Postgres in `apps/web`"; falsifier 6 means "the Postgres content tables and the content control-panel pages retire; the public pages are the ported design"; falsifier 7 covers both Workers.

### R2 (builder, 2026-10-16): the contact falsifier names the command that exists; what "retire" removed

Found while building against R1, not a change of intent.

- **Falsifier 3 as written does not match the command.** It says "one ticket, one audit row and one outbox row". `submitContact` (spec 0001, C10) has never stored the legacy ticket: it validates, then queues the notifications of RULE-249 in the caller's transaction, and an anonymous post is not a staff write, so it has no audit row. It writes **three outbox rows (four when the department has a Slack channel) in one transaction, and no ticket or audit row.** Falsifier 3 now reads: _the contact form queues the department's e-mail, the receipt, the department's Slack post when it has a channel and the #notifications post in one transaction and nothing else; a post without a Turnstile answer is refused with 422 and queues nothing; the RULE-156/167/249 tests pass._ `apps/web/e2e/public.spec.ts` counts and names the rows, shows that they carry one creation instant (`enqueue` writes them in one INSERT; `packages/db`'s transaction tests prove the rollback) and checks the audit count.
- **Falsifier 6, what went.** In `apps/web`: the control-panel pages `statisk-innhold`, `artikler` and `sponsorer`, their server functions, views and forms, and the sidebar sections and capabilities (`EditStaticContent`, `ManageArticles`, `ManageSponsors`) that gated them. In `packages/domain`: the static text, article-writing and sponsor-writing commands, services and audit actions, `home.ts` (the RULE-070 countdown, which mono-web's home page does not have). In `packages/db`: the tables `article`, `article_department`, `static_content` and `sponsor` and the enum `sponsor_size` (migration `content_moved_to_the_cms`, which also tightens the `audit_log` checks). Kept, because the public pages and the importer still use them: the pure rules RULE-326 (ten news items a page) and RULE-331 (front-page news order), the sponsor order, the sanitiser (RULE-133, now run by the CMS importer), slugs, social events (C8) and the file rules (C11).
- **Rules that moved.** RULE-296 (who edits texts) is EmDash's role model. RULE-133 is tested where the sanitiser and the Portable Text view are (`packages/domain` `sanitizer.test.ts`, `apps/web` `portableTextView.test.tsx`). RULE-267 (a draft is not public) is tested by the CMS client's published-only reads and by `public.spec.ts` (a draft article is 404). RULE-070 retired with the countdown.
- **Falsifier 4, how the import is split.** `tools/import` has two programs. `import` loads departments, semesters, fields of study, admission periods, social events and department logos into PostgreSQL (report format 2). `import:cms` reads the legacy articles, texts and sponsors from MySQL and writes them to EmDash over its REST API, with a counts-only report; the CMS refuses a slug that is taken (409) and the importer counts that entry as already there, so a rerun creates nothing. Images stay missing (D5): an article keeps its legacy image path until the file copy is authorised.
- **What a Preview shows (D6).** The CMS seed (`apps/cms/seed/seed.json`) carries the default copy of every text slot and every FAQ entry, taken from mono-web's pages, so a development, Preview or browser-test stage has a complete site before an editor has written anything. Production gets its content from the real importer and its editors. The seed holds no teams or people (fake personal data), so the team page says that no team is published until an editor adds one.

### R3 (builder, 2026-10-16): the deployed CMS Worker answered 500; the build check was not the deploy's build

Found by the lead on the first deploy of stage `main`, not a change of intent. Falsifier 7 says both apps have a base deployment; the CMS Worker was deployed and answered 500 to every request: ``Calling `require` for "events" in an environment that doesn't expose the `require` function`` (at `rolldown-runtime:45:8`, `dialect:3138:23`, `4462`, `4517`, `Object.middleware` in `app:21374`).

- **Cause.** EmDash's Hyperdrive adapter inlines `pg` (CommonJS) into the Worker bundle. Rolldown keeps a throwing `__require` for its `require("events")`, `net`, `tls`, `crypto` and the rest unless its `esmExternalRequirePlugin` turns them into imports (rolldown docs, "Bundling CJS" and "esm-external-require"), and workerd's ES modules have no `require`. Alchemy adds that plugin for `nodejs_compat`, and it had no effect: Bun installs `vite-plus-core` (Vite and rolldown) twice (`astro` and `@alchemy.run/frontend-frameworks` get `esbuild` peers 0.25.12 and 0.28.2), rolldown recognises its builtin plugins by `instanceof`, and an instance from the other copy is silently a plugin without hooks. Alchemy's own Worker bundler describes this (`Cloudflare/Workers/Sources/Rolldown.ts`, alchemy-run issue 880) and fixes it for plain Workers only. Rebuilding the same plugin with the executing copy cut the throwing calls from 29 to the 2 that are EmDash's own `createRequire`.
- **Why nothing was red.** `bun run build:cms` called `Astro.make({ root })` with no compatibility date or flags, so Alchemy's Node-compatibility transforms were off and the bundle was not the deployed one. The browser tests run `astro dev` with `@astrojs/cloudflare`, unbundled, so they cannot see a bundling defect.
- **Fix.** `apps/cms/build/ownExternalRequire.ts`, a Vite plugin that runs after Alchemy's and rebuilds each `builtin:esm-external-require` instance of a server environment with the `vite` that `astro` builds with (`vite` is now a dependency of `apps/cms`). `build:cms` is replaced by `bun run check:cms` (`apps/cms/scripts/checkBundle.ts`): it builds with `buildInChild` and the Worker's real compatibility date and flags, rejects a surviving throwing `__require` of a Node built-in, runs the server modules in workerd (Miniflare 5, pinned in the catalog) with Hyperdrive on a disposable PostgreSQL that `db/emdash-role.sql` set up, KV and R2, and requires `GET /_emdash/api/setup/status` to answer 200. It is part of `ready` and of CI.
- **Falsifier 7, added:** the CMS bundle as deployed answers its setup status in workerd (`bun run check:cms`). Evidence it can fail: without the plugin it names `dialect_*.mjs`; with that scan also off, workerd answers 500 with the deployed log.
- **Not provable here:** that Cloudflare's Hyperdrive over Neon answers. The first redeploy of `main` is that proof (`STATE.md`, Next 7).
