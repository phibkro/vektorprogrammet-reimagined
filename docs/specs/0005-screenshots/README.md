# Spec 0005 screenshots: the ported pages beside mono-web's

Falsifier 1 asks for a page-by-page comparison of this site with mono-web's homepage (`@monoweb/homepage`, commit `2aa6ce97`, the commit the pages were ported from). Each page has two JPEGs at 1280 px wide, full page: `<page>-1280-mono-web.jpg` (mono-web) and `<page>-1280-her.jpg` (here). Hjem and Kontakt also have a 390 px wide pair, `<page>-390-…`.

| Page        | Path                  | Both                              |
| ----------- | --------------------- | --------------------------------- |
| Hjem        | `/`                   | `hjem-1280-*`, `hjem-390-*`       |
| Om oss      | `/om-oss`             | `om-oss-1280-*`                   |
| Assistenter | `/assistenter`        | `assistenter-1280-*`              |
| Team        | `/team`               | `team-1280-*`                     |
| Foreldre    | `/foreldre`           | `foreldre-1280-*`                 |
| Skoler      | `/skoler`             | `skoler-1280-*`                   |
| Nyheter     | `/nyheter`            | `nyheter-1280-*`                  |
| An article  | `/nyhet/opptak-apner` | `nyhet-1280-*`                    |
| Kontakt     | `/kontakt`            | `kontakt-1280-*`, `kontakt-390-*` |

## What differs on purpose

- **Mono-web's homepage was a synthetic development build.** It carries a yellow `DEV CONTENT` banner with build digests, invented statistics ("42 Assistenter"), invented sponsors, a "Logg inn" link and placeholder footer rows ("Non-production development surface"). The layout, palette, pictures and wording are ported; the banner, the invented numbers and the login link are not (there is no sign-in before Phase 2).
- **Content comes from the CMS.** The texts are the default copy of `apps/cms/seed/seed.json` (mono-web's own wording where it had some), the FAQ is the CMS's `faq` entries, the article and the sponsor are the importer's fake fixture (`Opptak åpner`, `Sponsor En`), and the departments (`ALFA`, `BETA`) are the importer's fake departments in PostgreSQL.
- **Hjem's dark band shows the admission state** ("Opptaket er stengt for øyeblikket", RULE-119) where mono-web showed invented counts.
- **Team has no team cards.** The seed holds no teams or people, so the page says that no team is published until an editor adds one. Mono-web's card (`Rekruttering`) came from the stand-in API below.
- **Nyheter sits inside the site frame**, with the department filter and without an author's name (an EmDash author is a CMS user). Mono-web's list route is a bare list without header or footer.
- **Kontakt has a Turnstile field** (RULE-167; mono-web's form has none). The widget shows Cloudflare's always-pass test key and its "for testing only" notice.
- **Form controls are `base-nova` (Base UI) instead of Radix**: the corner radius and heights differ by a pixel or two where shadcn's two generations differ.

## How they were taken

Mono-web at `2aa6ce97`, exported with `git archive` into a scratch directory (its repository untouched), `bun install --frozen-lockfile`, then its own generator for the contract files that the git tree does not hold (`bun node_modules/@effx/cli/dist/effx.js build --project packages/http-api/tsconfig.effx.json --strict-access --emit=contract`), then `API_URL=<stand-in> HOMEPAGE_LOCAL_DEV=true bunx vite dev` in `apps/homepage`. Without an API its home, team, news and contact pages answer 503 (they read departments, teams and news from mono-web's API), so a 30-line stand-in served `/api/news`, `/api/news/opptak-apner`, `/api/departments` and `/api/teams` with the fixture's two departments, one article and one team card, in the response shape mono-web's SDK decodes (strong entity tags, `Cache-Control: public, max-age=60, s-maxage=300, must-revalidate`, coordinates as text).

This site: `vp dev` over a database filled by `bun run import:fixture`, with the CMS running (`apps/cms/README.md`) and filled by `bun run import:fixture:cms`.

Both were opened in Playwright's Chromium at 1280×900 (and 390×844), `reducedMotion: reduce`, locale `nb-NO`, waiting for the load event and then 1.8 s (4.5 s on Kontakt, for Turnstile's widget), and saved as full-page JPEGs of quality 80.
