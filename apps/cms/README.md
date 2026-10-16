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

## Content of a stage

| Stage | Where its content comes from |
| --- | --- |
| local (`bun run dev`) and the browser tests | the default copy in `seed/seed.json` (`content`: a text for every slot of the public pages, taken from mono-web's wording, and the FAQ entries), applied by the development bypass; then `tools/import`'s `bun run import:fixture:cms` adds the importer's fake articles, texts and sponsors |
| `main` and the Previews | the same, put in once: the setup wizard's "sample content" choice applies the seed's `content` (EmDash's `POST /_emdash/api/setup` takes `includeContent`), and `import:fixture:cms` adds the fake articles. A Preview's Neon branch forks `dev`, so it starts with `dev`'s content |
| production | the real legacy articles, texts and sponsors from `import:cms` (`tools/import/README.md` § Into the CMS), then the editors. No sample content |

- The seed holds no teams and no people: a team page without entries says that no team is published. Editors add `teams` entries in the admin.
- The seed's texts have a slug per slot (`about-header`, `home-tagline`, …); the page-to-slot map is `apps/web/src/lib/textSlots.ts`, and `apps/web/test/textSlots.test.ts` fails if a slot has no default copy. `about-faq` and `vektor_i_media` have none on purpose (no wording to port: they render nothing until an editor writes them).
- **Tokens.** `apps/web` reads with a personal access token that has the scopes `content:read` and `media:read`. The importer needs `content:read`, `content:write` and `schema:write` (it adds the department cities as options of `news.departments`), created by an administrator because writing a legacy publication date needs `content:publish_any`. A token acts for its creator, so one made by an administrator also reads drafts: the web client asks for `status=published` and refuses anything else.
- **Schema changes after the first deploy** (a new field, a new option) are made in the admin's Content Types (EmDash docs, "Evolving a deployed site"); editing `seed.json` does not change a deployed site.

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
- `bun run check:cms` (from the root; `bun run check:bundle` here) checks the Worker as it is deployed, see § The Worker bundle. It deploys nothing, needs the devenv PostgreSQL, takes about ten seconds, and runs in `bun run ready` and in CI.

## Deploy

`apps/web/alchemy.run.ts` declares the CMS Worker (base stage `main`, a Worker Preview per pull request, its own Hyperdrive configuration for `emdash_app` and its own R2 bucket). The infrastructure a stage needs is listed in the pull request description of spec 0005 and in `apps/web/README.md` § Stages and previews.

### The Worker bundle

`astro dev` and the browser tests run EmDash unbundled. The deployed Worker is a rolldown bundle that Alchemy builds (`Cloudflare.Website.Astro("Cms")`), and the first deploy of it answered 500 to every request: ``Calling `require` for "events" in an environment that doesn't expose the `require` function``. EmDash's Hyperdrive adapter inlines `pg`, which is CommonJS and requires `events`, `util`, `net`, `tls`, `crypto` and more. Rolldown turns a `require` of a Node built-in into an ES import only through its `esmExternalRequirePlugin` ([docs](https://rolldown.rs/builtin-plugins/esm-external-require)). Without it the bundle keeps a `__require` that throws ([docs](https://rolldown.rs/in-depth/bundling-cjs#require-external-modules)), and a Worker's ES modules have no `require`.

Alchemy adds that plugin to every Worker with `nodejs_compat`, and here it had no effect. Bun installs `vite-plus-core` (Vite and rolldown) twice, because `astro` and `@alchemy.run/frontend-frameworks` get different `esbuild` peers (0.25.12 and 0.28.2). Alchemy's plugin is an instance from one copy and the build runs in the other. Rolldown recognises its builtin plugins by `instanceof`, so it treats the foreign instance as a plugin without hooks and converts nothing: 29 throwing `__require` calls reached the bundle, 26 of them in the `pg` chunk. Alchemy's own Worker bundler describes this failure (alchemy-run issue 880) and cures it by rebuilding the plugin from its options with the copy that builds (`alchemy/src/Cloudflare/Workers/Sources/Rolldown.ts`, `configureCloudflarePlugins`); its Astro path does not. `build/ownExternalRequire.ts` does the same here: a Vite plugin that runs after Alchemy's and rebuilds every `builtin:esm-external-require` instance of a server environment with the `vite` that `astro` builds with. `vite` is a dependency of this workspace so that the import resolves to that copy. After the fix only two `__require` calls remain, EmDash's own `createRequire` for its registry verification.

`scripts/checkBundle.ts` (`bun run check:cms`) is the guard. It

1. builds as the deploy does: `buildInChild` from `@alchemy.run/frontend-frameworks`, the compatibility date and flags from `apps/web/worker.config.ts`, `output: "server"`;
2. scans the output for a `require()` of a Node built-in that the throwing `__require` still serves, and names the modules;
3. runs the server modules in workerd (Miniflare 5, the version `@cloudflare/vite-plugin` runs) with `nodejs_compat`, a Hyperdrive binding on a disposable PostgreSQL database that `db/emdash-role.sql` has set up, a KV namespace for sessions, an R2 bucket and an encryption key, and asks `GET /_emdash/api/setup/status`, which must answer 200: that first request loads `pg`, migrates EmDash's schema and applies the seed.

With the plugin removed, step 2 fails and names `dialect_*.mjs` (eleven built-ins). With step 2 also off, step 3 fails with the deployed Worker's log, line for line: 500 and ``Calling `require` for "events"`` at `rolldown-runtime:45:8`, `dialect:3138:23`, `app:21374` (`Object.middleware`). A regrouped install that puts `astro`'s Vite and the plugin's Vite in different copies again fails the same way.
