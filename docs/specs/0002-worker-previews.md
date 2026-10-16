# Spec 0002: Worker Previews for every pull request

**Status:** frozen when PR opens; later changes are dated entries under [Revisions](#revisions) · **Phase:** 1 (delivery infrastructure) · **Operator decisions (2026-10-16):** parent is a base stage `main`; previews deploy from CI on every pull request; the control panel stays anonymous in previews.

## Journey

1. **Anyone with the link** opens the base deployment, a Worker built from `main`, and sees the public site on fake data that the real importer migrated.
2. **A developer opens a pull request.** CI forks a Neon branch `preview/pr-<n>` from `dev`, migrates it, and deploys the pull request as a [Cloudflare Worker Preview](https://developers.cloudflare.com/workers/previews/) of the base Worker. One pull-request comment holds the Preview URL, and every push updates the same Preview and the same comment.
3. **The pull request closes.** CI destroys the Preview, its Hyperdrive config and R2 bucket, then deletes the Neon branch.

## Goal, constraints, values

- **Goal:** every change can be seen running on the real platform (Worker → Hyperdrive → Neon) before merge, without a hand-run deploy.
- **Constraints:**
  - Alchemy v2 is the one infrastructure root (`apps/web/alchemy.run.ts`). Cloudflare Previews belong to a parent script, and a Preview cannot own crons, domains, routes or Access.
  - drizzle-kit owns migrations: a branch is migrated **before** the Worker that reads it is deployed.
  - Neon branches come from Neon's own GitHub actions; the project's GitHub integration owns `NEON_API_KEY` and `NEON_PROJECT_ID`.
  - CI deploys with a scoped, account-owned Cloudflare API token that a credentials stack mints and writes into the repository's secrets ("credentials as code", [Alchemy CI guide](https://alchemy.run/environments/ci)). No token is pasted by hand.
  - Preview URLs are public. Previews and the base hold only the importer's **fake** fixture data, never the backup.
- **Values:** a preview can never mail real people or act as staff. `DEPLOYMENT=preview` builds the capture sink, and only `local` resolves a test actor; both rules are already structural.

## Falsifiers (definition of done)

1. The base stage `main` is deployed, and its public pages return 200 with fixture data.
2. This pull request gets a Preview: the comment's URL serves this branch's build, and its database is `preview/pr-<n>` (the dev data plus this branch's migrations).
3. A push updates the same Preview URL and the same comment; no second Preview, branch or comment appears.
4. Closing a pull request removes its Preview, Hyperdrive config, R2 bucket and Neon branch (checked on a throwaway pull request).
5. No preview or base deployment has a send-mail binding or Slack secret, and `/kontrollpanel` refuses staff actions there.
6. The CI token can deploy Workers, Hyperdrive, R2 and the state store, and nothing else (its permission groups are listed in the credentials stack).

## Revisions
