# @vektorprogrammet/cms

The editors' CMS: [EmDash](https://docs.emdashcms.com) 1.3.0 running **headless** on Astro. It serves EmDash's admin (`/_emdash/admin`) and its REST API (`/_emdash/api/`, OpenAPI 3.1 at `/_emdash/api/openapi.json`) and renders no public page: every visitor-facing page is a TanStack Start route in `apps/web`, which reads the published content over the REST API (spec 0005, revision R1).

| Fact | Where |
| --- | --- |
| Texts, news, sponsors, FAQ, teams | EmDash collections (`seed/seed.json`), stored in PostgreSQL schema `emdash` |
| Departments, admission periods, contact targets | PostgreSQL schema `public` (`packages/db`), read by `apps/web` |

## Runtime

```
editor ──► /_emdash/admin ──► Astro (Cloudflare Worker) ──► Hyperdrive (cache off) ──► Neon `emdash` schema, role emdash_app
apps/web ─► /_emdash/api/content/{collection}  (Bearer token, scope content:read) ─┘
media ───► R2 bucket (binding MEDIA), served from /_emdash/api/media/file/… (public, by design)
```

- **Database** (`hyperdrive({ binding: "HYPERDRIVE" })`, [EmDash docs](https://docs.emdashcms.com/deployment/database/#hyperdrive)): the Hyperdrive configuration must have query caching **off**; EmDash reads back what it just wrote. The role is `emdash_app`, which owns the schema `emdash` and holds no privilege on `public`; `vp_app` (the application's DML-only role) holds none on `emdash`. `db/emdash-role.sql` creates both, locally and on Neon.
- **Migrations and content model** are EmDash's own: core migrations run on the first request (`migrations.runtime: "auto"`), and `seed/seed.json` creates the collections on the first request before the setup wizard has run. Editing the seed later does not change a deployed site (EmDash: "Evolving a deployed site"); change the schema in the admin's Content Types.
- **Sign-in** is EmDash's own (passkeys and invites). Passkeys are bound to a hostname, so a Worker Preview (its own hostname, a Neon fork of `dev`) has no editor access. **A database without a completed setup shows the setup wizard to the first visitor, who becomes the administrator**: finish the setup right after the first deploy of a stage.
- **Reading from `apps/web`** uses a personal access token (`ec_pat_…`) with the scopes `content:read` and `media:read`. Anonymous API calls answer 401, except `/_emdash/api/media/file/…`. A token acts for its creator: created by an administrator it can also read drafts, so `apps/web` always asks for `status=published` and refuses anything else (`packages/cms-client`).
- **No scheduled publishing.** `Cloudflare.Website.Astro` generates the Worker entry, so EmDash's `scheduled` handler (`createScheduledHandler`) is not exported and publishing at a set time does not run. Editors publish now.

## Collections

| Collection | One entry is | Notes |
| --- | --- | --- |
| `texts` | one editable text on a public page | the entry's **slug is the key** the page looks it up by (the legacy `static_content.html_id`, e.g. `about-header`); `title` labels it in the admin |
| `news` | a news article | `sticky`, `departments` (city names; empty means all departments), `image`, `content`; the publication date is EmDash's `publishedAt` |
| `sponsors` | a sponsor | `name`, `url`, `size` (small, medium, large), `logo` |
| `faq` | a question and answer | `page` (`assistenter` or `team`), `position` |
| `teams` | a team of a department | `department` is the city; moves to PostgreSQL in phase 4 |

## Run it locally

Everything runs inside devenv; its PostgreSQL 18 (`devenv up -d`) stands in for Neon.

```sh
# once per database: the role and the schema (superuser, trust authentication locally)
devenv shell -- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/cms/db/emdash-role.sql

# the CMS on http://localhost:4321/_emdash/admin
devenv shell -- bash -c 'cd apps/cms && \
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://emdash_app:local@127.0.0.1:${PGPORT}/vektorprogrammet" \
  EMDASH_ENCRYPTION_KEY="$(bunx emdash secrets generate | tail -1)" \
  bun run dev'
```

- `bun run dev` sets `CMS_STANDALONE=1`: `astro.config.ts` then uses `@astrojs/cloudflare` over the local `wrangler.json` (Hyperdrive, R2 and compatibility settings; the Hyperdrive origin is the environment variable above). Without it the config declares no adapter, because Alchemy injects its own and fails the build on a configured one.
- In development `GET /_emdash/api/setup/dev-bypass?redirect=/_emdash/admin` signs in as a development administrator and completes the setup; `POST …/dev-bypass?token=1` also returns a personal access token with every scope. The browser tests and the importer use it. It exists only under `astro dev`.
- `pg` is pre-bundled (`vite.optimizeDeps.include`): without it the workerd module runner fails with `require is not defined`.
- `bun run build` builds the CMS exactly as Alchemy does (`scripts/build.ts`: Astro's programmatic build with Alchemy's Cloudflare adapter). It deploys nothing and runs in `bun run ready`.

## Deploy

`apps/web/alchemy.run.ts` declares the CMS Worker (base stage `main`, a Worker Preview per pull request, its own Hyperdrive configuration for `emdash_app` and its own R2 bucket). The infrastructure a stage needs is listed in the pull request description of spec 0005 and in `apps/web/README.md` § Stages and previews.
