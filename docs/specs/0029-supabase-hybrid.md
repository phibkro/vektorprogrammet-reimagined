# 0029 — Hybrid Supabase application

Status: local acceptance complete; hosted preview blocked on external prerequisites.

## Goal

Run one TanStack Start Worker with Supabase Auth, Storage and Postgres. Keep Effect domain rules and the existing Drizzle transaction adapter. Minimize handwritten SQL without weakening authorization, atomic audit or the business outbox.

## Scope and constraints

- Start from saved prototype 5d51f3c, integrate current origin/main, preserve newer admission/forms/retention/transaction work, and retain domain/cms plus unknown JSON preservation.
- Do not promote the experiment's SQL backend, middleware runtime, plain variant or validation duplication. Its branch remains evidence.
- Separate migration/bootstrap authority from runtime database authority. The runtime role is not a table owner, superuser, role administrator, database creator or RLS bypass role. Grant only the domain operations and narrowly identified provider reads actually required by existing application code.
- Authorization is server-owned: verified Supabase identity, current domain principal and existing Effect commands. Client Data API roles cannot access protected domain tables. RLS is enabled, but runtime role policies are not a second per-user domain authorization engine.
- Keep existing transaction modes, locks, cancellation behavior, audit, welcome ledger and durable outbox. No provider calls inside the membership transaction. Keep existing TypeScript email templates.
- Use a separate disposable synthetic Supabase project for mutation and browser proof. Preserve the interactive localhost:3000 prototype, other agents' branches and all unrelated data.
- Keep current due-aware, lease-fenced delivery. Cron/Queues replacement is a separate change only if it removes code while preserving those guarantees.
- No production data, credential/password import, live mail or Workspace changes. Hosted preview needs the dedicated synthetic target, approved control-plane access and verified native Auth capture SMTP. Terraform remains the sole hosted deployment owner.

## Acceptance

1. Upstream application capabilities remain in the hybrid branch. CMS schemas/contracts have one home, and root/nested unknown JSON survives draft save/read/publish while malformed known fields fail.
2. Normal application requests use restricted runtime database credentials. Actual SQL probes refuse schema creation, table alteration, role administration, privileged role switching and Auth writes. Runtime can execute the existing domain transactions. Database migration/bootstrap credentials do not become Worker bindings. Existing provider-admin SDK keys remain server-only, with their separate authority disclosed.
3. Anonymous, ordinary, wrong-department and deactivated callers cannot create memberships or read protected panel data through real Start endpoints. Browser credentials cannot bypass those endpoints through domain table APIs.
4. A real browser signs in as a synthetic authorized actor and creates a membership through the existing form. Observe the stored membership, audit, welcome claim and capture-only delivery alongside the rendered result.
5. A later statement failure rolls back membership, ledger, audit and outbox together. Repeated concurrent calls preserve the existing membership and first-welcome invariants. Reuse existing falsifiers and run affected formal/model checks when their covered implementation changes.
6. The application has one TypeScript domain implementation. Experimental RPC code is absent from its dependency graph and deployed artifact. No additional API server or queue transport is introduced.
7. Compile the actual Start Worker artifact, exercise it locally against native Supabase, and validate Terraform configuration. Hosted preview is complete only after its actual HTTPS journeys pass. Report unavailable hosted prerequisites precisely.

## Revisions

- Initial contract: operator selected Effect/TypeScript commands with the existing Postgres transaction adapter, Supabase managed services, server-owned domain authorization and a restricted runtime role. The first deliverable is the local browser journey plus hardening and CMS preservation. Hosted preview remains conditional on the named external prerequisites.
- Native inspection: managed Auth tables have RLS enabled and no policies. The normal bootstrap role can read them but cannot create owner-only policies. Keep runtime NOBYPASSRLS. Project only required metadata through private, read-only, security-barrier views owned by bootstrap. Grant runtime SELECT on these views, not managed Auth tables. This bounded owner-read exception preserves session/privacy metadata and one SQL export snapshot without provider calls inside transactions. Verify real native provider rows, denied credential columns, denied view writes and denied raw Auth access.
- Local inspection incident: a delegated psql invocation printed the disposable bootstrap DB URL. Only default local synthetic credentials were included. No hosted or random runtime credential was involved. The target remains disposable, generated runtime credentials remain private, and the owned stack stops after proof.
- Migration scope: use a fresh synthetic database for the reconciled upstream/prototype chain. The existing running 5d51f3c database is preserved, not silently upgraded. Prior-prototype upgrades require a separate rehearsal.

## Local acceptance results

Implementation branch: prototype/supabase-hybrid. The upstream merge includes origin/main fc8c2a9. The application retains one Effect/TypeScript domain implementation. The experimental SQL backend is not included.

| Criterion | Observed evidence |
| --- | --- |
| Fresh integration | Reconciled Drizzle migrations applied to a new native Supabase database. Application and impact tables have RLS. The original prototype was not upgraded. |
| Runtime authority | Actual requests connected as vektor_runtime, with superuser and RLS bypass false. Restricted-role tests refused DDL, temporary tables, role escalation, raw Auth access and projection writes. |
| Protected access | Native browser sessions produced 403 for ordinary, wrong-department and deactivated command replays. Anonymous command replay and protected page reads also returned 403. Four exposed domain tables refused anonymous/authenticated SDK reads. |
| Real membership journey | An administrator created a team and person, then added the first membership through the form. The result contained one membership, audit and welcome claim, plus two delivered intents and captured messages. A leader also succeeded before deactivation and lost access afterwards. |
| Rollback | An owned late outbox trigger displayed a failure in the real form. Membership, ledger and outbox stayed empty for that person. The membership-audit total stayed unchanged. The trigger and function were removed. |
| CMS preservation | Real title and rich-text edits, draft save and publication retained unknown root, block and span JSON. Known malformed fields remain rejected by codec tests. |
| Provider boundary | Native private Storage upload/download succeeded, anonymous download failed, and the owned object was removed. Actual privacy download included provider user, identity and session metadata without credential fields. |
| Artifact | The compiled Worker ran against native Supabase. A scan of 329 emitted JS/JSON/map files found no bootstrap URL, runtime URL or provider secret. Production secret bindings were empty. |

### Verification scope

The clean committed implementation 1cb988f passed the documented workspace command: nine units, 1481 tests. Tests used the configured PostgreSQL 18/MySQL services and native Supabase APIs. Separate native PostgreSQL 17 role/projection checks and the compiled browser journeys exercised the real provider boundary.

The later bootstrap-only containment correction rejects an inside-worktree directory whose name begins with two dots. The real CLI rejected that path before writing a credential and still accepted the private external path. The entire workspace suite was not repeated after this isolated correction. Format, lint, types, exception registry, store boundary, module graph, generated docs, Knip and clone detection passed afterwards.

Two affected credential browser tests passed against the compiled Worker. They cover native invitation POST refusal without provider proof, password transport in the body, and disabled prehydration credential controls. The complete browser suite did not run. The stale native refresh-session failure appeared as a 500 before its correction and rendered the login form afterwards.

Pinned effx regeneration completed for eleven domains. The maintained membership model passed all cases with source coverage reconciled: current-code visited 1712396 states. PostgreSQL race/rollback/code-probe tests are separate evidence. Provider lifecycle, production privileges and arbitrary concurrency are not conclusions of the model.

Terraform initialization, formatting and validation passed. No remote plan, import, apply or deployment ran. Local security advisors reported no error-level findings. Hosted acceptance remains blocked by the named target, credential and capture-SMTP prerequisites.

### Decisions retained

- Auth, Storage and provider requests use maintained Supabase SDKs. Domain rules, validation, transaction orchestration and email templates stay in TypeScript.
- The existing due-aware, lease-fenced outbox remains. No new API server or transport was added.
- Server authorization is the domain boundary. Private Auth projections deliberately use bootstrap-owner read authority, never arbitrary owner-executed business functions.
- Runtime provisioning revokes database PUBLIC TEMP capability, then preserves it for existing eligible login services. Future roles need explicit grants. This applies only to an explicitly owned synthetic target.
- Closed impact snapshots are append-only for the runtime role. Native SELECT/INSERT were allowed and UPDATE/DELETE denied. This does not attest hosted issue-71 privileges.
- Re-provisioning retained the private runtime credential unchanged. Malformed URLs and in-repository credential paths fail without logging values.

### Cleanup

The owned compiled Worker, native Supabase project and health loop stopped after proof. The owned PostgreSQL/MySQL test services stopped. Temporary failure injection and the mis-targeted spike role were removed. Synthetic volumes and matching private runtime credentials remain for reproduction. Clean disposable implementation worktrees were removed after their commits were integrated. The original localhost:3000 prototype still answered HTTP 200.

The managed browser tab closed on idle before explicit release. No user-owned browser or interactive baseline service was stopped. Evidence screenshots and private provider/download artifacts remain outside Git.
