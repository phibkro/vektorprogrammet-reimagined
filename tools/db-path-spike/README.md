# `@vektorprogrammet/db-path-spike` (slice 0000)

One throwaway Worker and one command that prove or disprove the database path every slice depends on. The contract is [`docs/specs/0000-database-path-spike.md`](../../docs/specs/0000-database-path-spike.md); the outcome is [`docs/specs/0000-results.md`](../../docs/specs/0000-results.md).

```
smoke (Bun) ── HTTPS ──▶ Worker vp-spike-0000 ── Hyperdrive (cache off) ──▶ Neon `dev`, role vp_app
  src/smoke.ts            src/worker.ts           DatabaseLive + Drizzle effect-postgres
  judges every check      runs one check          on one @effect/sql-pg client (prepare: false)
```

The Worker only runs a check and answers with facts. The verdicts (`src/verdicts.ts`) live in the runner, so a Worker cannot grade itself. The tables are in schema `spike_0000`; Phase 1's tables are untouched.

## Run the checks

```sh
devenv shell -- bun run --cwd tools/db-path-spike smoke --url https://<worker-host>   # or SPIKE_URL=https://<worker-host>
```

One `PASS`/`FAIL` line per check with its evidence beneath; exit 0 only if every check passes. The same command is the smoke test for a deployed preview.

Check 1 names the Worker script version it ran against. After a deploy, run `GET /checks/connect` until it returns the new `workerVersion` every time, then run the checks: for about 30 s the old version still answered some requests, and a run that mixes versions proves nothing about either.

## Rehearse locally

`devenv shell -- bunx vp test` runs every check, its verdict and the client abort of check 3b against devenv's PostgreSQL 18 as role `vp_app`, with a negative control for each check that could pass silently (the unique constraint dropped or renamed, a transaction nothing interrupts). It cannot prove the platform: Hyperdrive, Neon and workerd. A local pass means a deployed failure is the platform's.

## Deploy

`with-neon-env.sh` derives the Neon values from SecretSpec's `NEON_API_KEY` and runs the command that follows it. Nothing is printed or written.

The spike tables come first, applied as `neondb_owner` over a direct connection, outside the Worker (`vp_app` keeps DML-only rights):

```sh
SECRETSPEC_REASON="apply the spike_0000 migrations" devenv shell -- secretspec run -- \
  tools/db-path-spike/with-neon-env.sh owner bun run --cwd tools/db-path-spike db:migrate
```

Then the Worker and the Hyperdrive config, with Alchemy v2 (stage `spike`, profile `production`); add `--yes` to run it without a terminal:

```sh
SECRETSPEC_REASON="deploy the vp-spike-0000 Worker" devenv shell -- secretspec run -- \
  tools/db-path-spike/with-neon-env.sh app bun run --cwd tools/db-path-spike deploy
```

| How the Hyperdrive origin password reaches Cloudflare |  |
| --- | --- |
| Source | `NEON_APP_PASSWORD`, from SecretSpec into the Alchemy process's environment |
| Route | read with `Config.Redacted` and handed to the Alchemy Hyperdrive resource. Alchemy writes it into its state document inside a `{"__redacted__": …}` envelope, and the Cloudflare state store encrypts each document at rest (AES-CTR). It is in no file, argument or log. Cloudflare checks the origin on create, so a placeholder cannot stand in. |

### The Cloudflare sign-in used for this deployment

The Alchemy profile `production` needed an interactive browser sign-in (`needs-reauth`). With the operator's approval the deployment ran with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` taken from the operator's `cf` OAuth session and set only in the environment of the Alchemy process, never in an argument, a file or a log. Alchemy printed `Cloudflare: using environment variables … instead of the profile.` and left the profile untouched. To return to the normal path:

```sh
devenv shell -- bunx alchemy profile refresh --profile production --provider Cloudflare
```

## CPU time of check 10

A Worker cannot measure its own CPU time (workerd's clock only moves on I/O), so the run reports an upper bound from the client. The platform's figure is in Workers Logs: one invocation event per request, with `cpuTimeMs`, `outcome` and `scriptVersion.id`. Events appear about a minute after the request.

```sh
devenv shell -- bun run --silent --cwd tools/db-path-spike cf observability telemetry query --body "{\"queryId\":\"vp-spike-0000\",\"timeframe\":{\"from\":$(( $(date +%s) - 900 ))000,\"to\":$(date +%s)000},\"view\":\"invocations\",\"limit\":500,\"parameters\":{\"datasets\":[\"cloudflare-workers\"],\"filters\":[{\"key\":\"\$metadata.service\",\"operation\":\"eq\",\"type\":\"string\",\"value\":\"vp-spike-0000\"}]}}"
```

On the Free plan a request is capped at 10 ms of CPU, so check 10 would end with `exceededCpu` instead of passing.

## Teardown

Removes the Worker, the Hyperdrive config (Alchemy, stage `spike`) and the spike tables (schema `spike_0000` and its migration journal), and nothing else:

```sh
SECRETSPEC_REASON="tear down the slice 0000 spike" devenv shell -- secretspec run -- \
  tools/db-path-spike/with-neon-env.sh both bun run --cwd tools/db-path-spike teardown
```

`alchemy destroy … --dry-run` lists exactly two deletions (the Hyperdrive config and the Worker). Both steps are safe to repeat.

## Notes

- `apps/web` also needs `@effect/platform-bun` (or `@effect/platform-node`) in its dev dependencies before its own `alchemy.run.ts` can run; this package carries `@effect/platform-bun` for that reason.
- The Worker takes its compatibility date and flags from `apps/web/worker.config.ts`, so the spike runs the production configuration. Check 3b depends on one of those flags: see the results.
