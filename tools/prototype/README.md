# Local Supabase prototype

Use a local-only Supabase CLI installation (the configuration was written for CLI 2.111.0), Bun and a container runtime. From the repository root:

```sh
supabase start
umask 077
supabase status -o env > /tmp/vektor-supabase.env
export SUPABASE_ENV_FILE=/tmp/vektor-supabase.env
export RUNTIME_DATABASE_URL_FILE=/tmp/vektor-supabase-runtime-url
export SYNTHETIC_SUPABASE_OWNED=1
devenv shell -- bun run prototype:setup
devenv shell -- bun run prototype:dev
```

The status file contains administrator credentials; the separate runtime URL file is generated privately and must remain outside Git and logs. Set SYNTHETIC_SUPABASE_OWNED=1 only for a local isolated target you own. Setup never rotates an existing runtime password: a mismatch fails. The application gets only the restricted runtime URL, never the migration URL. Both targets must be direct loopback URLs. Bootstrap creates private, security-barrier, owner-read Auth projections exposing only the fields used by the server. It revokes database TEMPORARY from PUBLIC to prevent runtime DDL, preserving it explicitly for existing login roles other than runtime. New roles need explicit TEMPORARY grants.

Setup applies the existing Drizzle migrations, runs the domain local seed, adds matching Supabase Auth users and two private Storage buckets (`public-files` and `receipts`), and adds a published synthetic tagline if absent. It does not overwrite existing content or a conflicting user or make a public bucket private silently. Run it again safely. The sample login addresses are `ada.admin@example.org`, `lise.leder@example.org`, and `nora.nybegynner@example.org`; their public fixture password is `LOCAL_FAKE_PASSWORD` in `apps/web/test/fixtures/localPeople.ts`. The setup checks an actual Ada sign-in without printing the session.

Local Supabase CLI development credentials are shared and intended only for disposable synthetic data; local container ports can be reachable on network interfaces beyond loopback. Restrict network access and never use this stack for real data or production credentials. Legacy credential migration is a separate operator gate.

## Browser verification

Never run mutating browser tests against the interactive prototype. Use a separate local Supabase CLI project with a distinct project id, ports and private status file. The project's Auth site URL must match the test Worker origin exactly. The local CLI config intentionally disables global public signup while leaving the email provider enabled; disabling `auth.email.enable_signup` disables password login on the tested CLI version. Invite and recovery templates are declared in that same config.

The authoritative fixture sequence is the `Prepare browser fixtures in local Supabase` step in [checks.yml](../../.github/workflows/checks.yml): migrate, run the real synthetic legacy import (requires devenv MySQL), prototype setup, extra browser fixtures, then provision the extra Active provider identities. Test entry points require `E2E_DISPOSABLE=1`; this is an explicit assertion that the caller owns the synthetic target, not an isolation mechanism.

Supply `E2E_MAILPIT_URL` for that project's local capture API. If port 3000 belongs to the interactive prototype, launch an owned Worker at another loopback port with matching `SITE_URL`, and pass its origin as `E2E_BASE_URL`. `with-env.sh` preserves an explicit `SITE_URL`; Vite supplies the normal prototype default when none is provided. Use the same private Supabase status file for the Worker and the test runner.

```sh
E2E_DISPOSABLE=1 E2E_MAILPIT_URL=http://127.0.0.1:56434 E2E_BASE_URL=http://localhost:3100 \
  SUPABASE_ENV_FILE=/path/to/private-isolated-status.env \
  devenv shell -- bash tools/prototype/with-env.sh bun run e2e
```

All actors use real Supabase sessions. There is no actor-switch cookie, CMS process or simulated R2 fixture. Turnstile test-key verification still needs outbound access to Cloudflare's documented public test endpoint. Keep captured links and browser traces private; they can contain synthetic bearer tokens. Stop only the app/project owned by the test run, preserving the interactive stack. The older repository browser-verification skill describes retired infrastructure; use this guide and the current CI sequence rather than its old launch/actor scripts until that user-authored skill is separately migrated.

Workspace tests that exercise the real provider also need the status mapping:

```sh
SUPABASE_ENV_FILE=/path/to/private-local-status.env \
  devenv shell -- bash tools/prototype/with-env.sh bun run test:all
```
