# 0029 — Hybrid Supabase application

Status: build. Operator approved the hybrid plan after the SDK/SQL experiment.

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
