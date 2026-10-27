---
name: verify-vektorprogrammet
description: "Drive the reimagined Vektorprogrammet web app (public site, contact form, control panel, team memberships) the way a user does, on a disposable migrated and seeded stack, and capture proof that survives cleanup. Use to verify a change or to review a pull request in this repository."
---

# Verify Vektorprogrammet

You are reading this cold, mid-task. This skill starts the real app (a TanStack Start Worker under `vp dev`, the EmDash CMS, a disposable PostgreSQL database), checks that the instance is worth driving, drives a feature the way a user does, saves evidence, and tears everything down without touching the evidence.

The surface is a **web UI**: the public site (`/`, `/kontakt`, `/nyheter`, …) and the control panel (`/kontrollpanel/…`). The CMS is a second server that only editors use. There is no CLI surface. Read `AGENTS.md` for the rules of the repository (devenv for everything; no `--no-verify`; check CPU and memory before a browser run).

It reuses the repository's own harness instead of a parallel one: `apps/web/e2e/support/stack.ts` (the stack, also used by `bun run e2e`), the `vp-test-actor` cookie for who is signed in, the Playwright specs in `apps/web/e2e`, and the capture sink for mail. What this skill adds is `apps/web/e2e/serve.ts` (the stack kept alive instead of running the specs once), the shell scripts in `scripts/`, and the feature map in `features/`.

```
scripts/launch.sh  ──►  headroom check ─► devenv PostgreSQL + MySQL ─► bun e2e/serve.ts (foreground)
                                                  └─ disposable DB (migrate, import fixture, seed people)
                                                     → CMS (astro dev, fixture imported twice) → vp dev (+ cron once)
                                                  prints "VERIFY READY origin=… cms=…"
scripts/doctor.sh  ──►  read-only: is it alive, ours, at this commit, with usable data?
drive:   scripts/drive.sh (committed Playwright specs)  ·  scripts/page.sh  ·  scripts/shot.sh  ·  scripts/probe.sh
scripts/cleanup.sh ──►  stop what we started, drop the DB, remove scaffolding; the run directory stays
```

Every path below is relative to this skill's directory, `.agents/skills/verify-vektorprogrammet/`. Run scripts by their full path from anywhere inside the worktree you are verifying (they find the tree with `git rev-parse --show-toplevel`; set `VERIFY_TREE=<path>` to verify another worktree).

## Launch

```sh
.agents/skills/verify-vektorprogrammet/scripts/launch.sh
```

Run it under a supervisor that keeps custody of the process and waits for a ready line. Never background it with `nohup`, `setsid` or `&`: custody is what makes cleanup reliable. In OMP: the `bash` tool with a `name` (for example `verify-<sha>`) and `ready: { "log": "VERIFY READY", "timeout": 600 }`. With Herdr: `hub start` then `hub wait`. The script stays in the foreground until the stack is interrupted.

What it does, in order (read `scripts/launch.sh`, it is short):

1. **Refuses to double-drive.** One instance per worktree. If the pointer (`<git dir>/verify-run`) names a live run it stops with that run's directory; a stale pointer is cleaned first.
2. **Checks headroom** (`scripts/headroom.sh`): CPU idle, `MemAvailable`, swap free and swap-in rate, busy time of the disk the worktree and evidence sit on, free disk, each with at least 20% left after the job's expected demand (stack 5.5 GiB RSS measured, plus a browser). I/O pressure is printed, not gated. Short on any → it exits 1 and says which. `VERIFY_FORCE=1` skips it and the report records that. Wait for another job to finish rather than forcing.
3. **Installs dependencies** in a fresh worktree: `devenv shell -- bun install --frozen-lockfile` (the system Bun hangs).
4. **Starts devenv's PostgreSQL 18 and MySQL 8.4** with `devenv up -d` if they are not usable, and waits until both are (MySQL's `legacy_reader` user exists). The importer needs MySQL: it loads the fake legacy fixture into a throwaway MySQL database first. Start both together; see the Gotchas.
5. **Overlay.** A worktree older than this skill (a PR head) lacks `apps/web/e2e/serve.ts` and `apps/web/e2e/support/stack.ts`. They are copied in from the skill's own tree as untracked verification scaffolding, listed in the run directory's `overlay.list`, and removed by `cleanup.sh`. A tree that has them is left alone.
6. **Execs `bun e2e/serve.ts`** (in `apps/web`, inside `devenv shell`): a disposable PostgreSQL database `vp_db_test_*` (created, migrated), the importer's fake fixture into it, the six local people (`db:seed:local`), the CMS (`astro dev` on the database's `emdash` schema, the importer's fixture imported twice to prove idempotence), `vp dev` on a random port with the `local` deployment (test actor, capture sink, simulated R2) and Cloudflare's always-pass Turnstile test keys, and the cron's `scheduled` handler run once (it makes the current and next semester). Only then it writes `state.env` and `secrets.env` and prints `VERIFY READY origin=http://localhost:<port> cms=http://localhost:<port>`.

From nothing (no `node_modules`, no devenv data directory) that is: install (about 15 s warm), devenv's first start (about 15 s), migrate + import + seed + CMS + `vp dev` (about 40 s on 2026-10-27). **Ready means usable**: the line is printed only after the app answered, the CMS imported its fixture twice, and the cron ran. `scripts/doctor.sh` then confirms it.

Knobs (environment): `VERIFY_TREE` (worktree to verify), `VERIFY_EVIDENCE_ROOT` (default `~/.local/state/vektorprogrammet-verify`), `VERIFY_FORCE=1`, `DEMAND_CPUS` / `DEMAND_MEM_MIB` / `DEMAND_DISK_MIB`.

Isolation: ports are drawn at random (30000–50000), the database name is unique, the pointer is per worktree. Two worktrees can run side by side, each with its own devenv services (devenv allocates their ports), if headroom allows; two instances in one worktree are refused. Never drive an origin this run did not print.

## Doctor

```sh
.agents/skills/verify-vektorprogrammet/scripts/doctor.sh
```

Read-only. Prints `DOCTOR OK` and exits 0 only if: `serve.ts` is alive; the worktree is still at the revision that was launched (a `git checkout` underneath a running instance makes every observation about another commit); the `vp dev` and CMS ports are owned by this run's process tree; `/`, `/kontakt` and the CMS status answer 200 and the CMS needs no setup; Ada Admin opens the control panel, an anonymous visitor gets `Ikke innlogget`, Nora Nybegynner gets `Ingen tilgang` (the test actor works); and the database holds departments, at least two semesters, six people, memberships and an admin place. Run it before the first drive, after any failed drive, and whenever a page looks wrong. On `DOCTOR FAILED`, read `serve.log` in the run directory, run `scripts/cleanup.sh`, relaunch.

## Drive

Pick the feature file(s) for what you are verifying from `features/README.md` (index, seeded people, conventions) and follow it. Four tools, all writing into the run directory (`state.env` names it; `scripts/*.sh` find it through the worktree's pointer):

- **The repository's specs** — `scripts/drive.sh <spec file regex> [-g "<title regex>"] [playwright options]`, for example `scripts/drive.sh public.spec.ts -g "falsifier 3"`. It sets `E2E_BASE_URL`, `E2E_CMS_URL`, `E2E_CMS_TOKEN`, `E2E_DATABASE_URL` from this run, turns tracing on (`playwright/<test>/trace.zip`: every action, DOM snapshot and network call), writes `results-<n>.json`, `drive-<n>.log` and the specs' own screenshots into `screenshots/`. Exit code is Playwright's. These are the same specs CI runs (`journey`, `public`, `shell`, `teams`; `accounts` on spec 0007), so a green run proves exactly what the spec asserts and nothing else.
- **What the server decided** — `scripts/page.sh <path> --as "<person>"|anonymous [--name <label>]`: status, redirect, title, `h1`, the control-panel links of the page, saved as HTML + headers in `pages/`. No browser: it shows authorisation before any script runs. `--as` is required; without the cookie the instance silently acts as Ada Admin.
- **What it looked like** — `scripts/shot.sh <path> <name> --as "<person>"|anonymous [--phone]`: a full-page Chromium screenshot (1280×900, or 390×844) into `screenshots/<name>.png`. Read the image; do not assume it.
- **What it stored** — `scripts/probe.sh "<select …>" [--name <label>]`: one read-only SQL statement against this run's database (`default_transaction_read_only=on`), statement and result saved in `probes/`. Tables: `outbox`, `audit_log`, `membership`, `person`, `team`, `position`, `department`, `semester`, `admin_grant` (`packages/db/src/schema.ts`).

For a journey no spec covers (typical for a pull request that adds UI), drive the origin from `state.env` with your own browser driver (an OMP `browser` tab, or a throwaway Playwright test file you keep out of the commit) after setting the cookie `vp-test-actor=<person>` for host `localhost` (the page `/kontrollpanel` also lists a `Testaktør` switch). Prefer ARIA roles and visible Norwegian labels over CSS selectors, as the specs do. Keep your own captures in the run directory.

Where the stack is the real thing and where it is not: the app, the CMS (real EmDash), PostgreSQL 18 and the browser are real. Mail and Slack are not sent: only production builds those senders; `local` gets the capture sink, which logs `outbox message captured (non-production deployment) { kind: … }` to `serve.log` and lets the outbox row reach `delivered`. Turnstile is the real Cloudflare script and verification with Cloudflare's always-pass test keys, so the contact form needs outbound network. R2 is simulated by the Cloudflare plugin.

## Evidence

The run directory is `~/.local/state/vektorprogrammet-verify/<UTC time>-<short sha>/` (override the root with `VERIFY_EVIDENCE_ROOT`). It is outside the worktree, outside `/tmp` and outside every path a worktree or `git clean` removes. `cleanup.sh` never deletes it. Contents:

| Path | What |
| --- | --- |
| `REPORT.md` | commit, branch, tree status at launch, features driven, spec results, every artifact with size and SHA-256, teardown time |
| `state.env`, `meta.env`, `git-status.txt`, `overlay.list` | what the run was (no secrets) |
| `serve.log` | everything the stack printed: `vp dev`, the CMS, the capture sink's lines |
| `drive-<n>.log`, `results-<n>.json`, `playwright/` | spec output; traces |
| `screenshots/`, `pages/`, `probes/` | what you captured |
| `secrets.env` | the CMS token of this disposable run; mode 0600; removed by cleanup |

Proof standards:

- **Exercise the real user path.** Browser clicks, real form posts, real pages. Not internal setters, not test-only endpoints, not a database edit. The `vp-test-actor` cookie is the repository's own stand-in for sign-in until spec 0007; say which person acted.
- **Capture the action and the resulting state**, not only the final screen: the trace or screenshot of the action, a `probe.sh` read of the stored row, the capture-sink lines for mail.
- **Verify side effects next to what is visible**: outbox rows for contact posts, `audit_log` for staff writes, `membership` rows for team changes. Compare against a `probe.sh` taken _before_, never a fixed count.
- **Mocks only where a production boundary already isolates the external system.** Here that is exactly mail and Slack (the capture sink) and R2. Observing what a mode skips beats trusting its name: the capture sink is verified by the log lines and `delivered` rows, and Turnstile in this mode still calls Cloudflare.
- **A failed journey stays failed.** Record the reason, keep the artifacts, and do not weaken the check. Report an unreachable path with the command tried and the missing precondition; never report a skipped entry point as verified through another.
- Run `scripts/report.sh --features "<ids>"` before cleanup to record what you drove (`cleanup.sh` regenerates `REPORT.md` and adds the teardown).

## Cleanup

```sh
.agents/skills/verify-vektorprogrammet/scripts/cleanup.sh
```

Stop the supervised launch first if you can (OMP: kill the named bash job), then run this; it also stops `serve.ts` itself (SIGTERM, which `runMain` turns into interruption, so the scope closes `vp dev`, the CMS and the database in reverse order; SIGKILL after 90 s). It only ever touches what this run recorded: the `serve.ts` pid (checked against `/proc/<pid>/cmdline`), listeners on this run's two recorded ports, the recorded `vp_db_test_*` database, the overlay files in `overlay.list`, `secrets.env`, the pointer, and devenv's PostgreSQL and MySQL **only if this launch started them**. Never kill by process name. It is safe after a failed launch and safe to run twice. It ends by printing the run directory and its contents: confirm the evidence is there. After a failed iteration of anything here, run it before the next try, so broken attempts do not strand processes and ports.

## Helpers

| Script | Invocation | Purpose |
| --- | --- | --- |
| `scripts/launch.sh` | `scripts/launch.sh` (supervised, foreground) | start the stack, print `VERIFY READY` |
| `scripts/doctor.sh` | `scripts/doctor.sh` | read-only health and identity check |
| `scripts/drive.sh` | `scripts/drive.sh public.spec.ts -g "falsifier 3"` | run committed Playwright specs against this run |
| `scripts/page.sh` | `scripts/page.sh /kontrollpanel --as "Lise Leder"` | server-rendered page as an actor |
| `scripts/shot.sh` | `scripts/shot.sh /kontakt contact --as anonymous [--phone]` | screenshot as an actor |
| `scripts/probe.sh` | `scripts/probe.sh "select count(*) from outbox" --name outbox-before` | read-only SQL, saved |
| `scripts/report.sh` | `scripts/report.sh --features "contact-send"` | write `REPORT.md` |
| `scripts/cleanup.sh` | `scripts/cleanup.sh` | tear down, keep evidence |
| `scripts/headroom.sh` | `scripts/headroom.sh` | the admission check on its own (launch runs it) |
| `scripts/lib.sh` | sourced by the others | tree, run directory, state loading |

`apps/web/e2e/serve.ts` and `apps/web/e2e/support/stack.ts` are repository code (also `bun run e2e:serve` in `apps/web`): `run.ts` and `serve.ts` both build the stack with `startStack`. If the harness in `apps/web/e2e` changes shape, update `stack.ts` once and `/maintain-verification-skill` for the rest.

## Reviewing a pull request

The open pull requests are stacked (each one's base is the branch below it), so a PR's head contains everything beneath it. Review it at its **head**, against its **base**.

1. **Get the head into its own worktree**, next to the others, from a clean place (never from a dirty worktree someone else is using):

   ```sh
   N=13
   git fetch origin pull/$N/head:pr-$N
   git worktree add ../reimagined-pr-$N pr-$N
   BASE=$(gh pr view $N --json baseRefName --jq .baseRefName)
   git -C ../reimagined-pr-$N diff --stat origin/$BASE...pr-$N     # what the PR changes
   ```

   Launch from that worktree with the skill's scripts: `VERIFY_TREE=$PWD/../reimagined-pr-$N .agents/skills/verify-vektorprogrammet/scripts/launch.sh` (supervised, as above). It installs dependencies there, brings the migrations of that head up on a fresh database (a migration that does not apply fails the launch, which is itself a finding), and overlays the harness files the head lacks. Use `VERIFY_TREE=… scripts/doctor.sh`, `drive.sh`, … for the rest (or run them from inside that worktree). When done: `VERIFY_TREE=… scripts/cleanup.sh`, then `git worktree remove ../reimagined-pr-$N` once the evidence is kept (it is in the evidence root, not in the worktree).

2. **Pick features from the changed paths** (`git diff --name-only origin/$BASE...pr-$N`):

   | Changed path | Drive |
   | --- | --- |
   | `apps/web/src/routes/kontrollpanel/**`, `components/panel/**`, `functions/panel.functions.ts`, `server/shell.ts`, `server/panel.ts`, `lib/panelSections.ts`, `packages/domain/src/**` grants and commands | [control-panel-sidebar](features/control-panel-sidebar.md): every seeded person with `page.sh`, plus `shell.spec.ts` |
   | `apps/web/src/server/teams.ts`, `routes/kontrollpanel/team/**`, `personer.tsx`, `teamForms.tsx`, `packages/db/src/repositories/teams.ts`, membership migrations | [team-memberships](features/team-memberships.md) on a fresh instance, plus the sidebar for the member it creates |
   | `apps/web/src/server/contact.ts`, `contactPost.ts`, `turnstile.ts`, `senders.ts`, `outboxDelivery.ts`, `outboxSweep.ts`, `routes/kontakt/**`, `packages/domain/src/contact/**` | [contact-form](features/contact-form.md), both outcomes and the no-JS post |
   | `apps/web/src/routes/*.tsx` outside the panel, `components/site/**`, `src/lib/textSlots.ts`, `apps/cms/**`, `packages/cms-client/**` | [public-site](features/public-site.md) |
   | departments, semesters, fields of study (`server/panel.ts`, `routes/kontrollpanel/{avdelinger,semestre,linjer,arrangementer}.tsx`, `packages/domain/src/organisation/**`) | [organisation-admin](features/organisation-admin.md) |
   | `packages/db/drizzle/**`, `packages/db/src/**`, `bun.lock`, `package.json`, `devenv.nix`, Effect or Drizzle versions | the launch itself, then every feature in order (`drive.sh journey.spec.ts`, then each of `public`, `shell`, `teams` on a fresh instance each, they write by fixed names); the package tests (`vp run -r test`, real-PostgreSQL race tests) are a different job and not covered here |
   | `apps/web/src/lib/authClient.ts`, `routes/logg-inn.tsx`, `server/account*`, `accounts.spec.ts` (spec 0007, PR #13) | `drive.sh accounts.spec.ts` on a fresh instance, **and** note that the `vp-test-actor` shortcut may no longer be how people sign in there: read `apps/web/src/lib/testActor.ts` and the spec first. The map has no feature file for accounts yet: write one from what you drove |
   | `apps/web/e2e/**` | run `drive.sh` for every spec the change touches and read the diff of `support/` for what a spec stopped asserting |
   | docs, specs, `AGENTS.md`, `.agents/**` only | nothing to drive; say so, and verify the docs' claims against the code instead |

   A feature file lists more entry points than one run covers; a proof that drives one convenient entry point (the browser form) when the change also touches another (the no-JS post) is incomplete. Drive each entry point the change can reach, or list the ones you skipped.

3. **Attach to the review** (a comment on the PR, written by whoever has authority to post; this skill never pushes or comments):
   - the head commit (`REPORT.md` has it) and the run directory path;
   - `REPORT.md` (features driven, spec pass/fail counts, artifact hashes) and the doctor output;
   - for UI changes, screenshots per affected person (`shot.sh`), the old behaviour where the base can show it (launch the base branch the same way and compare, or say that you did not);
   - for stored-state changes, the `probe.sh` before/after files;
   - for any failed or flaky spec, its `trace.zip` and `drive-<n>.log` excerpt;
   - what was **not** driven and why, and every stand-in (the cookie actor, the capture sink, simulated R2, Turnstile test keys).

## Stand-ins and what is unverified

- The local stack stands in for Cloudflare: `vp dev` with the Cloudflare Vite plugin (workerd) instead of deployed Workers, devenv PostgreSQL 18 instead of Neon through Hyperdrive, a simulated R2, the capture sink instead of Cloudflare Email Service and Slack, `astro dev` instead of the CMS Worker bundle. Whatever those differ in is unverified here: `bun run check:cms` (the bundled CMS in workerd) and the deployed Previews cover the rest (AGENTS.md: "Run what is deployed, not a stand-in").
- Sign-in is the `vp-test-actor` cookie. Passkeys for editors, Better Auth and accounts are not driven by the features here.
- Dependency install, devenv services and the headroom check run on this host; a clean machine adds the Nix builds that `devenv` does first.

## Gotchas

- **Start both devenv services together.** `devenv up -d postgres` first and a later `devenv up -d` leave MySQL running without its configure task: no `legacy` database, no `legacy_reader`, and the importer fails with a bare `script "import:fixture" exited with code 1`. `launch.sh` waits at most 120 s for `legacy_reader` and tells you to `devenv down && devenv up -d`.
- The specs write by fixed names (departments, `Dokumentasjonsteam`, three people), so a second run of the same spec on one instance fails for that reason. Relaunch for a clean story; do not edit the spec to pass.
- `serve.ts` binds `localhost` (Vite resolves it to `::1` on some hosts); use the origin printed in `state.env`, not `127.0.0.1`.
- `devenv`'s own "Running devenv:…" lines are filtered from the helper scripts' stderr; the launch's output keeps them.
- A run that never prints `VERIFY READY` and never exits is not "slow": read the end of `serve.log`.
- Hooks: `bun install` runs the root `prepare` script (`vp config`, `effect-tsgo patch`) as in any checkout. Never commit with `--no-verify`.
