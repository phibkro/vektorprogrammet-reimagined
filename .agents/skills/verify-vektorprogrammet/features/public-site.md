# Public site

An anonymous visitor reads the organisation's public pages: the home page, the information pages, the team and school pages, the news list and an article. Their texts, FAQ, news and sponsors come from the CMS (EmDash) and the department lists from PostgreSQL; an edit published in the CMS shows without a deploy, a draft never does, and the legacy URLs answer 301 (spec 0005, falsifiers 1, 2 and 5).

## Sub-features

- `site-pages` each page renders its `h1` and the `h2` headings that its CMS texts and layout give it.
- `site-home` `/` shows the CMS tagline, published news, the sponsors and the admission state.
- `site-departments` `/team`, `/nyheter`, `/kontakt` and `/skoler` list the active departments of PostgreSQL.
- `site-news` `/nyheter` lists published articles and `/nyhet/<slug>` shows one; a draft is not public (RULE-267).
- `site-faq` the FAQ blocks of `/assistenter` and `/team` are the CMS's `faq` entries.
- `site-edit-publish` a text saved in the CMS stays invisible until published, then shows on the next load.
- `site-redirects` legacy URLs answer 301 to their new homes; an unregistered legacy file path answers 404.

## How to get to it (user POV)

- Open `/`, then follow the header and footer links to `/om-oss`, `/assistenter`, `/team`, `/foreldre`, `/skoler`, `/nyheter` and `/kontakt`.
- Open an article from the news list or at `/nyhet/opptak-apner`.
- Open an old address: `/om`, `/bedrifter`, `/faq`, `/omvektor`, `/artikkel/<slug>`.
- An editor changes a text in the CMS admin (`<cms origin>/_emdash/admin`, reached with the development bypass `<cms origin>/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`) and publishes it.

## Driving it with verify-vektorprogrammet

Preconditions:

- `scripts/doctor.sh` printed `DOCTOR OK`; the CMS answers at the `E2E_CMS_URL` of `state.env`.
- No other run has left an edited `home-tagline` text in this CMS (a fresh launch has none).

- **Whole story from the repository's spec.** Run `scripts/drive.sh public.spec.ts -g "falsifier [125]"`. It covers every sub-feature above except the contact post (see [contact-form](./contact-form.md)). Exit code `0` and all tests `passed`; the spec saves `screenshots/public-home-edited.png` and `screenshots/public-contact.png`.
- **What the server says per page.** For each of `/`, `/om-oss`, `/assistenter`, `/team`, `/foreldre`, `/skoler`, `/nyheter`, `/nyhet/opptak-apner`, `/kontakt` run `scripts/page.sh <path> --as anonymous`. Status `200` and `h1` respectively `Vektorprogrammet`, `Om Vektorprogrammet`, `Assistenter`, `Våre team`, `Informasjon for foreldre`, `Vektorassistenter i skolen`, `Nyheter`, `Opptak åpner`, `Kontakt oss`.
- **Redirects.** `scripts/page.sh /om --as anonymous` prints `301` and `location: /om-oss`; the same for `/faq` (`/om-oss`) and `/artikkel/opptak-apner` (`/nyhet/opptak-apner`); `/kontakt/avdeling/1` gives `/kontakt/alfaby`; `/filer/nope` gives `404`.
- **Look at it.** `scripts/shot.sh / home --as anonymous` and `scripts/shot.sh /nyheter news --as anonymous --phone` write `screenshots/home.png` and `screenshots/news.png`. Check the pictures against what the page claims: tagline, news cards, sponsor row.
- **Edit and publish, as an editor does.** The spec's falsifier 2 saves a draft text through the CMS REST API with the run's token, checks `/` still shows the old tagline, publishes, checks the new one shows, and puts the original back. To drive the admin screen yourself open `<cms origin>/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin` in a browser; it signs you in as `dev@emdash.local`.
- **Stored state.** The departments on the pages are rows: `scripts/probe.sh "select id, short_name, city, active from department order by id" --name departments` must list the same names that `/kontakt` shows in `Velg avdeling`.
- **Proof.** `scripts/report.sh --features "site-pages, site-home, site-news, site-edit-publish, site-redirects"`; attach the drive log, `results-<n>.json`, the two spec screenshots and any `page.sh` outputs.

## Gotchas

- Texts are CMS entries named in `apps/web/src/lib/textSlots.ts`; a page shows layout and headings itself and everything else from the slot. A page whose text is missing from the CMS renders without it, silently: look at the picture, not only the status.
- Article pictures and sponsor logos are missing until the file copy is authorised (AGENTS.md, "Not done yet"): a news card without its picture is the known state, not a regression.
- `scripts/page.sh` shows the server-rendered HTML only. Client behaviour (tabs, hydration) needs the spec or `scripts/shot.sh`.
- The `public.spec.ts` tests run as one serial story; `-g` selects some, and a later test may expect an earlier one's leftovers only where the spec says so (it reads departments from the database instead of assuming them).
- The home page's admission state depends on the current date and the seeded admission periods; do not assert its wording from the first run.
