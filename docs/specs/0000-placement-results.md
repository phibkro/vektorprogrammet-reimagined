# Spec 0000 placement experiment results

**Date:** 2026-10-27. **Origin:** Norway (Cloudflare `cf-ray` colo suffix was `OSL`; one request was `ARN`). **Scope:** sequential dependent SQL statements in one transaction, over the same Neon/Hyperdrive path, comparing default Worker placement with targeted Frankfurt placement. This is an experiment, not a production recommendation.

## Method

The reproducible method is `tools/db-path-spike/src/worker/chain.ts` and `GET /chain?n=1|4|8|17`, exposed by `tools/db-path-spike/src/worker/http.ts`. Each statement is `select previous_value::int + 1`; all statements run sequentially in one transaction. Response `statementsMs` is accumulated statement-call time; `dbMs` includes transaction start/commit around the calls; `totalMs` is the measured handler time. The client separately records wall time. Both Workers shared one cache-disabled Hyperdrive config and the same Neon database/role. The default arm had no targeted placement; Frankfurt used Cloudflare targeted placement `aws:eu-central-1`.

Commands used (from repository root):

```sh
# Refresh Alchemy's production profile from tools/db-path-spike, not repository root
cd tools/db-path-spike
CI=false devenv shell -- bunx alchemy profile refresh --profile production --provider Cloudflare
cd ../..

# Apply experiment-owned tables, deploy, and run the benchmark scripts
SECRETSPEC_REASON="apply spike_0000 migrations" devenv shell -- secretspec run -- tools/with-neon-env.sh owner bun run --cwd tools/db-path-spike db:migrate
SECRETSPEC_REASON="deploy placement experiment" CI=false devenv shell -- secretspec run -- tools/with-neon-env.sh app bun run --cwd tools/db-path-spike deploy
# placement-bench.mjs was run against both URLs for 100 requests/cell (batches of 10).
# placement-cold.json used 100 concurrent requests/cell after a 5-minute idle wait.
```

`CI=false` is necessary for these local Alchemy commands: inherited `CI=true` selects CI credentials rather than the selected `production` profile and fails with `Missing required env: CLOUDFLARE_ACCOUNT_ID`. The refresh command must run from `tools/db-path-spike`, where Alchemy and `@effect/platform-bun` are installed; from repository root `bunx` fetched a global Alchemy copy that failed to load that peer.

## Measurements

All cells contain 100 successful HTTP 200 requests. Values are milliseconds, nearest whole ms; percentile is nearest-rank (ceil(p*n)). `wall` is caller-observed end-to-end, `DB` is `dbMs` measured in the Worker, and `stmt` is `statementsMs`. The instrumented `totalMs` equals `DB` in these captures (the timed handler only wraps the transaction); DB values are therefore reported once.

| Placement | Statements | Phase | n | Wall p50/p95 | DB p50/p95 | Statements p50/p95 |
| --- | --: | --- | --: | --: | --: | --: |
| default | 1 | warm | 100 | 261 / 730 | 183 / 288 | 55 / 94 |
| default | 4 | warm | 100 | 385 / 842 | 338 / 563 | 218 / 345 |
| default | 8 | warm | 100 | 603 / 1047 | 558 / 889 | 438 / 707 |
| default | 17 | warm | 100 | 1044 / 1718 | 1014 / 1692 | 905 / 1497 |
| Frankfurt | 1 | warm | 100 | 143 / 579 | 50 / 149 | 13 / 46 |
| Frankfurt | 4 | warm | 100 | 162 / 612 | 72 / 282 | 40 / 180 |
| Frankfurt | 8 | warm | 100 | 209 / 630 | 117 / 446 | 88 / 343 |
| Frankfurt | 17 | warm | 100 | 328 / 983 | 216 / 826 | 181 / 724 |
| default | 1 | cold-labelled | 100 | 430 / 772 | 187 / 277 | 50 / 63 |
| default | 4 | cold-labelled | 100 | 646 / 985 | 353 / 525 | 205 / 241 |
| default | 8 | cold-labelled | 100 | 691 / 1218 | 560 / 784 | 391 / 471 |
| default | 17 | cold-labelled | 100 | 1180 / 2036 | 1052 / 1746 | 839 / 959 |
| Frankfurt | 1 | cold-labelled | 100 | 534 / 821 | 121 / 182 | 14 / 32 |
| Frankfurt | 4 | cold-labelled | 100 | 583 / 1121 | 123 / 210 | 55 / 100 |
| Frankfurt | 8 | cold-labelled | 100 | 576 / 805 | 163 / 270 | 96 / 154 |
| Frankfurt | 17 | cold-labelled | 100 | 622 / 1019 | 202 / 319 | 158 / 259 |

### Cloudflare placement observations

`cf-placement` was `null` on every default-placement response and `remote-FRA` on every Frankfurt response (all 800 observations per phase). `cf-ray` showed the caller-facing Norway colo `OSL`, with one Frankfurt n=4 cold-labelled observation served at `ARN`; targeted Frankfurt placement did not change the ingress colo. The explicit placement was therefore observed on the Worker response, rather than inferred from its URL.

## Interpretation

In these captures explicit Frankfurt placement reduced the median Worker DB time and end-to-end wall time at every count from 1 through 17, in both warm and cold-labelled batches; the largest warm DB p50 change was 1014→216 ms at 17 statements. The result is consistent with reducing repeated Worker-to-Neon round-trip distance, but p95s overlap substantially, especially for 1/4 statements, so the experiment does not establish a universal tail-latency improvement or a production SLO.

## Limits and additional cold samples

The file `placement-cold.json` has 100 requests per nominal cell but those requests were sent concurrently after one idle wait per cell. It does **not** establish that all 100 requests saw a suspended Neon compute; only the first could have encountered a cold wake, so the table labels these cells “cold-labelled”, not cold-start measurements. A separate serial script (`placement-cold-seq.mjs`) waited six minutes before every request. Its log captured 13/24 planned entries before interruption; one post-resume Frankfurt n=4 sample is separately recorded in `/tmp/placement-cold-seq-resume.json`, making 14 available serial observations. The serial dataset is incomplete, has fewer than 100 samples/cell, and is excluded from percentiles. As soon as the experiment had usable 100-sample comparisons, the deployment was torn down; the remaining serial observations could not be collected after teardown.

Other limitations: one Norwegian client location and one Neon region; 100 observations per cell from one run; concurrent batching can introduce load/queue effects; elapsed times are sensitive to network variance and cold connection state; the measurements compare the configuration used in this spike, not a general placement guarantee. `dbMs` includes transaction setup/commit; `statementsMs` sums statement calls; neither is pure network RTT.

## Teardown and proof

The authorized teardown ran on 2026-10-27 with stage `spike`, profile `production`, and `CI=false`:

```sh
SECRETSPEC_REASON="tear down slice 0000 spike" CI=false devenv shell -- secretspec run -- \
  tools/with-neon-env.sh both bun run --cwd tools/db-path-spike alchemy destroy alchemy.run.ts --stage spike --profile production --yes
SECRETSPEC_REASON="drop slice 0000 spike schema" CI=false devenv shell -- secretspec run -- \
  tools/with-neon-env.sh owner sh -c 'psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "drop schema if exists spike_0000 cascade" -c "drop table if exists public.spike_0000_migrations"'
```

Alchemy's dry-run plan named exactly three deletions—`Database`, `PlacedWorker`, `Worker`—and six bindings. The destroy completed `3 succeeded`; output named both `vp-spike-0000-default` and `vp-spike-0000-frankfurt` and the Hyperdrive deletion. `DROP SCHEMA` succeeded and cascaded only to `spike_0000.spike_codec`, `spike_counter`, `spike_row`, and `spike_semester`; the migration journal drop succeeded. A post-destroy database query returned no rows for the `spike_0000` schema or `spike_0000_migrations`. Cloudflare pre-destroy list calls had found exactly the two prefixed Workers and `vp-spike-0000-neon-dev` Hyperdrive. After deletion, `cf workers scripts search --name vp-spike-0000` returned `[]`; `cf hyperdrive list` returned the other account configs and no `vp-spike-0000*` name. A post-destroy `information_schema.tables` query returned no matching schema or migration journal.

`vp check` was not run: live measurements showed active swap-in (271 then 204 pages/s) and sustained I/O wait; running a full project check under that pressure was unsafe. The uncommitted spike changes remain as the reproducible method. `vp check` should be run when swap-in and device load subside.
