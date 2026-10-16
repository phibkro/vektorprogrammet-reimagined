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
