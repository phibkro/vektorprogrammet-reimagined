# 0000c: Workers placed next to the database

**Status:** frozen when its pull request opens · **Evidence:** [`0000-placement-results.md`](https://github.com/phibkro/vektorprogrammet-reimagined/blob/spike/placement-latency/docs/specs/0000-placement-results.md) (branch `spike/placement-latency`, 9afb942)

## Problem

Every database statement is a round trip between the Worker and Neon, which runs in `aws-eu-central-1` (Frankfurt). With Cloudflare's default placement a Worker answering a request from Norway runs near the visitor, so each statement crosses Europe. Slice 0000's placement run measured the median database time of 17 sequential statements at 1014 ms with default placement and 216 ms with targeted placement in Frankfurt; the gap grows with the number of statements a command makes.

The Neon project was created outside Alchemy. Its region was a fact in the documentation only, so the Workers and the database could drift apart without any check failing.

## Contract

1. `NEON_REGION` in `apps/web/worker.config.ts` is the one declaration of the database's region.
2. `WORKER_PLACEMENT` is derived from it (`{ mode: "targeted", region: "aws:<region>" }`); no other code writes a region.
3. Both Workers (`Web`, `Cms`) of the long-lived stages (`main`, `production`) carry it. **Previews do not.** "Previews do not inherit production settings" ([Preview configuration](https://developers.cloudflare.com/workers/previews/configuration/)): placement is set per Preview deployment, and the page's "top-level placement applies to Previews" is Wrangler copying the top-level value into each Preview it creates. Alchemy `2.0.0-beta.83` creates Previews with `ignoreBaseConfig: true` and sends no `placement` in the Preview deployment (`WorkerProvider.ts`), so Previews run at Cloudflare's default placement, before and after this change. A Preview is therefore slower to Neon than `main` and `production`; its latency is not a measure of theirs.
4. The Preview workflow reads the live Neon project's `region_id` and fails when it differs from `NEON_REGION`.

## Falsifiers

1. Declaring another region in `NEON_REGION` fails the Preview workflow's region check (checked locally: the live project reports `aws-eu-central-1`, which matches, and a different declared value does not).
2. After merge and the redeploy of `main`, a request to the `main` Web Worker returns a `cf-placement` header naming a Frankfurt location (`remote-FRA` in slice 0000's run), and the Worker's settings in Cloudflare show targeted placement in `aws:eu-central-1`.
3. `vp check` and `ready` pass.

## Not in this change

Managing the Neon project itself in Alchemy (`Neon.Project` with `region`). Its `delete` deletes the project, so adopting the production database needs a retain policy first; a region cannot change on an existing Neon project, so the region check covers the drift that matters.

Placement for Previews: Alchemy would have to forward the Worker's `placement` into its Preview deployment (the Cloudflare API accepts it there). That is an upstream change to Alchemy.
