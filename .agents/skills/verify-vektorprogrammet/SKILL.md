---
name: verify-vektorprogrammet
description: Verify the application on an owned disposable local Supabase target with real authentication and the maintained browser suite. Use for application changes and pull-request reviews.
---

# Verify Vektorprogrammet

Use the exact checkout under review. Record its commit and dirty state. Do not overlay harness files from another checkout. Use separate worktrees, dependencies, Supabase projects, ports and evidence directories for concurrent reviewers.

## Prepare the target

1. Read the current [prototype guide](../../../tools/prototype/README.md) and the `Prepare browser fixtures in local Supabase` step in [CI](../../../.github/workflows/checks.yml). The CI step is the source for fixture order and commands.
2. Install this checkout's pinned dependencies with `devenv shell -- bun install --frozen-lockfile`. Do not share a `node_modules` symlink between worktrees.
3. Own a fresh local Supabase CLI project with a distinct project ID, ports, database and Auth site URL. Its site URL must match the Worker origin exactly. Never reset or use the interactive prototype or a remote target.
4. Start the services needed by the CI fixture sequence, including devenv MySQL. Record which processes and projects this run owns. Do not stop another run's services.
5. Store the Supabase CLI status file and runtime URL file outside Git with private permissions. Set `SUPABASE_ENV_FILE`, `RUNTIME_DATABASE_URL_FILE`, `SYNTHETIC_SUPABASE_OWNED=1` and `E2E_DISPOSABLE=1` only for this owned synthetic target. Run the CI fixture sequence in order: migrate, import the synthetic legacy fixture, `prototype:setup`, `seedExtra.ts`, then `tools/prototype/seed.ts`.
6. Set `E2E_MAILPIT_URL` to this project's local Mailpit API. Turnstile also requires outbound access to Cloudflare's public test endpoint.

`E2E_DISPOSABLE=1` is an ownership assertion, not isolation. `with-env.sh` rejects non-loopback provider targets. The app uses real Supabase Auth sessions and private Storage. It has no test-actor cookie or separate CMS process.

## Run and select coverage

Before each heavy job, measure CPU load and PSI, available memory, swap and swap-in, memory and I/O PSI, device utilization and filesystem free space. Include all owned jobs. Admit the job only with at least 20% resource headroom after its expected demand. Monitor these signals while it runs. Use a supervisor that retains process custody and the exit status.

For shared application changes, run the full maintained suite on the fresh target:

```sh
devenv shell -- bash tools/prototype/with-env.sh bunx vp run e2e
```

The runner uses `apps/web/e2e/run.ts` and `support/stack.ts`. It starts an owned Worker on port 3000 unless `E2E_BASE_URL` names an existing local Worker. If port 3000 is occupied, start a separately owned Worker on another port with matching `SITE_URL` and pass its origin as `E2E_BASE_URL`. Never point tests at the interactive prototype. A reused Worker must use the same private Supabase target as the runner.

Route changed paths to evidence as follows. Inspect the actual specs and changed behavior, not just their names.

| Changed paths | Browser evidence |
| --- | --- |
| `apps/web/src/features/<feature>/`, related routes or feature tests | Run the relevant maintained specs in `apps/web/e2e/`. Add a real user journey for changed behavior that the specs do not cover. |
| `apps/web/src/core/`, `src/adapters/`, `src/server/`, `src/http/`, `drizzle/`, shared UI or configuration | Run the full maintained browser suite. Also exercise changed behavior that the suite does not cover. |
| `apps/web/e2e/`, prototype bootstrap, fixture code or workflow | Run the affected flow and the full suite when shared setup or lifecycle changes. |
| Other paths | Determine impact from actual callers and the PR spec. Record why browser coverage is or is not required. |

Paths in the second row are relative to `apps/web/`. A feature can cross these boundaries. Use the broader row when in doubt. A targeted run can pass Playwright arguments through `vp run e2e`, but serial stories can depend on earlier steps. Use a fresh fixture target for each independent run.

For interactive investigation, run the same fixture sequence first. Then supervise `devenv shell -- bash tools/prototype/with-env.sh bunx vp run @vektorprogrammet/web#e2e:serve` with a private `VERIFY_RUN_DIR`. `serve.ts` writes a private `state.env` and prints `VERIFY READY`. The state contains a database URL and public-file key, not CMS state. Sign in through the application's real login with synthetic fixture accounts. Use separate browser contexts for separate people. Do not assume that readiness proves a user journey.

## Evidence and cleanup

Record the head, changed paths, target ownership, commands, exit statuses, selected coverage, observations and uncovered behavior in a private run directory outside the worktree. Preserve failures and screenshots or traces needed to reproduce them. The default Playwright configuration retains traces and screenshots on failure only. Record any extra capture settings and their output paths. A passing test proves only its assertions.

Treat status files, runtime URLs, `state.env`, browser traces, screenshots, logs and captured mail links as potentially secret. Do not print credentials or publish bearer links. Redact evidence before sharing it. Keep private originals separate from public reports.

Stop only the supervised Worker and services owned by this run. Stop only its isolated Supabase project and remove only its disposable resources. Preserve the interactive prototype, operator services and evidence. Record cleanup and any resources that remain. Local browser evidence does not prove a deployed Worker, hosted provider settings or real message delivery.
