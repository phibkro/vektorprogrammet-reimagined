# Spec 0007: Accounts and sessions

**Status:** frozen when PR opens; later changes are dated entries under [Revisions](#revisions) · **Phase:** 2 · **Source:** brief §7 "Auth library and session model" (2026-10-15, refined 2026-10-16) and "Information model and personal data" (accepted 2026-10-26); `docs/system/administration.md`; INFORMATION_MODEL §9.3; ADR 0007, 0008, 0009; spec 0006 (principals, grants, kernel), spec 0006a (diagnostics policy). Split on 2026-10-27 from the draft "Accounts, sessions and personal data": the personal-data half is spec 0007b, so each spec is one journey and one pull request.

## Journey

1. **A team leader** opens a person of their department on the Team page and invites them. The person gets an e-mail (a capture sink outside production) with a link that works once and expires after 14 days.
2. **The invited person** opens the link, chooses a password and is signed in. A person with a membership lands in the control panel, on the sections the membership allows; a person without one lands on Min side.
3. **On Min side** the person edits their profile, sees their sessions (each client with its created and last-seen time) and ends one, and changes their password.
4. **Someone who forgot their password** asks for a reset with any e-mail address and always reads "If an account exists, we sent a link". Only an Active account gets the mail.
5. **An admin deactivates** an account. The person's next request is anonymous, and sign-in is refused exactly as a wrong password is. The admin can reactivate it. Nothing else about the person changes.

## Goal, constraints, values

- **Goal:** accounts and sessions on the principals of ADR 0008: a person signs in, the session yields the principal that spec 0006's grants authorize, and every credential path refuses an account that is not Active.
- **Constraints:**
  - **Better Auth is a library inside the one Worker** (`apps/web/src/server/auth.ts` (new)). It has its own `pg` pool over the same Hyperdrive binding (brief §7, accepted 2026-10-16) and owns four tables only, `auth_user`, `auth_session`, `auth_account` and `auth_verification` (set with `modelName`, so they do not meet the domain's `account`), defined in `packages/db/src/schema.ts` like every table. `auth_user.person_id` (unique, references `person`) is the only link between the two. A domain command never writes an auth table in its transaction: it enqueues an outbox message that the delivery performs after commit. The library's own routes (`/api/auth/*`) are rate limited by the Workers `RateLimit` binding that `/kontakt` uses, not by the library's per-isolate memory.
  - **Sign-in and settings screens are better-auth-ui's** (`shadcn add @better-auth-ui/auth` into `apps/web/src/components/auth/` (new)), held to the `base-nova` rules of `AGENTS.md`. Check at adoption that they build on Base UI; if they build on Radix, the `@better-auth-ui/react` hooks drive `base-nova` components instead (one UI kit). Activation and reset pages are ours: they hold a code, not a session.
  - **The principal comes from the session** (ADR 0008, spec 0006 R1). `resolvePrincipal` (`apps/web/src/server/principal.ts`, spec 0006) reads the cookie with `auth.api.getSession`, then reads once from the domain: the Account state and the memberships. The result is `Person { personId, memberships, adminUntil? }`, or `Anonymous` when there is no valid session, the Account is not Active, or no Account exists. `session.disableSessionRefresh` and `advanced.ipAddress.disableIpTracking` are on: a read writes nothing and no IP address is kept. The `vp-test-actor` cookie stays, in `local` only.
  - **One Account machine** (ADR 0007, guards as Schema checks per spec 0006 R4): `Invited → Active ⇄ Deactivated`, one `account` row per person. Every path that creates a session passes one guard, a `databaseHooks.session.create.before` that refuses a non-Active Account; the resolver above covers sessions that already exist, so a deactivation bites on the next request. A refusal is byte-identical to a wrong password. Leaving Vektorprogrammet never deactivates an account: access ends because the engagements end.
  - **Passwords:** 8 to 64 characters and at most 72 UTF-8 bytes (where bcrypt truncates), one range for activation, change and reset (RULE-126, 166). `password.hash` and `password.verify` are both overridden with one bcrypt implementation that runs on Workers: cost 12 for new hashes (RULE-024), and `$2y$`, `$2a$` and `$2b$` accepted, so a legacy hash and a new one share one algorithm and nothing is rehashed. There is no sign-up route (`disabledPaths`): an account exists only through `invite`. The identifier is the private or the company e-mail, "remember me" lasts 365 days (RULE-281), and a change or reset of the password ends the other sessions (`revokeSessionsOnPasswordReset`).
  - **One construct for single-use codes:** `Code { purpose, subject, hash, expiresAt, usedAt }` (`packages/domain/src/accounts/code.ts` (new)). 256 random bits; only the SHA-256 is stored; expiry is a stored instant compared whole; use is a conditional update with one winner. The policy per purpose is data: `activation` 14 days, `resetPassword` 24 hours. Spec 0007b adds `alumniConsent`; spec 0009 adds `unsubscribe` and `verifyEmail`. A new code for the same purpose and subject invalidates the older (RULE-220). The plaintext lives in the e-mail only: the outbox row is redacted once delivered.
  - **A code is a credential that narrows** (ADR 0008). Presenting one opens a session whose principal is the person it was issued to, restricted to the one command and resource its purpose names (`activate`, `resetPassword`). `authorize` allows a command only when a grant matches the principal and the narrowing, if there is one, names that command and resource. A narrowing never widens: an `Admin` holding an activation code can do nothing else through it.
  - **The reset request** (`Anyone`, after Turnstile and the per-IP limit, as `/kontakt`) answers the same for every e-mail (RULE-112, operator decision 2026-10-26) and issues a code only to the private e-mail of an Active account. A code whose account is deactivated before use is refused at use.
  - **Sessions record their client:** the user agent (one pure function reads it as browser, system and desktop, phone or tablet) and the creation time. Last seen is derived, never written by a read: the later of the creation and the latest audited command of the session. Audit rows gain `session` and `client` (`browser`, `server`, `scheduler`, `import`) beside spec 0006's `person_id` / `system_job`. A person sees and ends their sessions (better-auth-ui's sessions card). Ending a session or signing out touches no domain row.
  - **One Person per verified e-mail** is a partial unique index. `activate` verifies the e-mail; spec 0009 verifies an applicant's.
  - **Hyperdrive:** no advisory locks, no LISTEN/NOTIFY; every job is idempotent through conditional statements. Every new read, including `resolvePrincipal`, is registered with the SELECT-only role test (`apps/web/test/readsNeverWrite.postgres.test.ts`).
  - **Diagnostics (spec 0006a):** any new unstable Effect or platform module needs an allowlist row and an exception record, decided by the lead.
- **Values:** one fact, one home. The state of an Account is the domain's; the credential is the library's.

## Declarations (new kernel use)

- **Narrowing:** `Principal.narrow(principal, { command, resource })` and the `authorize` rule above. A code holder's grant is `Grant.make(Holder(purpose), [command], own)`. `activate` and `resetPassword` are code-only commands: `Admin` holds no row for them, as for the job-only commands of spec 0006 R1.
- **The Account machine** is declared with `Machine.make` and its guards are Schema checks with representations, so the effx domain-model generator (ADR 0009) reads it like the Membership machine.
- **Commands (`AccountRpc`):**

| Command | Transition | Granted to | Scope |
| --- | --- | --- | --- |
| `invite(person)` | — → Invited | `Leader(d)` of a department of the person (a membership or a field of study there; spec 0011 adds placements) | department |
| `activate(code, password)` | Invited → Active | the `activation` code | own |
| `requestPasswordReset(email)`, `resetPassword(code, password)` | — | `Anyone` (Turnstile, limit); the `resetPassword` code | — / own |
| `deactivate`, `reactivate` | Active ⇄ Deactivated | `Admin`, never one's own, never the last Active admin | all |
| `updateProfile` | — | `Self ∪ Leader(d)` | own / department |

## Behavior contract

| Rule | After |
| --- | --- |
| RULE-125, 104, 116 | Every credential path refuses an account that is not Active; single sign-on is the pure predicate `ssoAllowed` (Active account and an active membership: a grant, not a role) |
| RULE-024, 126, 166, 281 | Password and session rules are the library configuration above: bcrypt cost 12, 8 to 64 characters everywhere, the private or company e-mail, 365 days with remember-me |
| RULE-131, 132, 201, 220 | Codes are hashed, expiring, single-use and purpose-bound; a resend invalidates the older code; `activate` moves only Invited → Active |
| RULE-112 | A reset request answers the same for every e-mail; the code goes only to an Active account |
| RULE-202, 299 | `deactivate` and `reactivate` by `Admin`, never one's own |
| RULE-207, 323 | `invite` by `Leader(d)` for a person of d; no password until activation; nobody "starts as assistant" |
| RULE-143 | One profile schema for self-edit, leader edit and invitation |
| RULE-328 | After sign-in: the control panel if the principal has a section, else Min side |
| RULE-214 | Retired with the access-rule tables: no unhandled entries to resolve |

## Falsifiers (definition of done)

1. **Legacy hashes verify.** Fixtures made by PHP `password_hash($p, PASSWORD_BCRYPT, ['cost' => 12])` (`$2y$12$…`) and by `$2a$` and `$2b$` verify with their password and fail with another. A truncated hash and a password over 72 bytes are refused. A new hash has cost 12 and verifies. Negative control: the library's default verifier rejects the `$2y$` fixture. Run on Node and in workerd.
2. **Every path refuses a non-Active account.** A property over accounts in each state and every way to make or use a session (password sign-in, the session after activation, an existing session, a code session) lets only Active through, and the refusal equals a wrong password's byte for byte. Removing the `session.create.before` guard, or the Account check in `resolvePrincipal`, makes it fail (negative controls). `ssoAllowed` holds exactly for Active accounts with a membership that satisfies start ≤ current semester ≤ end, at the boundary instants of RULE-022. `deactivate` of the last Active admin is refused.
3. **The reset answer does not leak.** Requests for an Active, an Invited, a Deactivated, an unknown and a company e-mail get the same status and body; one outbox row exists, for the Active one only; a code whose account is deactivated before use is refused (real PostgreSQL).
4. **Codes.** A property over generated codes: 20 concurrent uses have one winner; a code is valid at `expiresAt − 1 ms` and refused at `expiresAt`; another purpose or resource is refused; a resend refuses the older code. An `activation` code in the hands of an `Admin` runs `activate` and nothing else. After `invite`, no text or jsonb column of any table holds the plaintext, and after delivery the outbox row does not either; leaving the redaction out fails the scan (real PostgreSQL).
5. **Sessions and reads.** Two sign-ins from two clients list two sessions with parsed client, created and derived last-seen. Ending one leaves the other valid and every domain row of the person unchanged; a password change ends the others. `resolvePrincipal` with a valid session past `updateAge` succeeds under the SELECT-only role; with refresh enabled it dies on `permission denied` (negative control).
6. **Declarations.** The Account machine passes spec 0006's completeness test (every command granted, every transition in its group); its guards round-trip through `SchemaRepresentation`.
7. **Browser journey.** Playwright, reading the capture sink through the test database: a leader invites, the person activates from the e-mail's link and signs in, sees the sections their membership allows, edits the profile, lists and ends a session; then an admin deactivates and the next request is anonymous. CI is green, and the pull request's Worker Preview serves sign-in and Min side for a seeded fake account and refuses it after deactivation.

## Open for the operator

These are recorded and do not block code (operator approval 2026-10-26).

- **Single sign-on:** the external client of the legacy `/sso/login` is not in the repository. Named, it is served by Better Auth's OIDC provider behind `ssoAllowed`; if there is none, the predicate stays unused.
- **Production input for the Phase 2 exit:** a sample of migrated production hashes that must sign in (falsifier 1's fixtures stand in).

## Out of scope

Personal-data declarations, consents, photos, export, erasure, merge and retention (spec 0007b); passkeys and two-factor sign-in (credential kinds that Better Auth plugins can add later); e-mail templates, delivery and Google company accounts (spec 0008); importing legacy accounts and password hashes (spec 0013).

## Revisions

### R1 (2026-10-27): mint codes at delivery

The lead resolves the conflict between the all-table plaintext scan and an outbox that contains the e-mail link. `invite` and `requestPasswordReset` commit an outbox message naming only the purpose and subject, without a code. Delivery mints the code in its own transaction, invalidates the older code for that purpose and subject, stores only the hash, renders and sends the e-mail with the plaintext in memory, and marks the message delivered. A retry mints a fresh code and invalidates the previous one (RULE-220).

The capture sink is a mailbox that exists only outside production and necessarily holds the link. Falsifier 4 scans every text and jsonb column after the command, after delivery and after a retried delivery, excluding exactly the capture-sink table for that reason. No other table, including the outbox, holds the plaintext code. As a negative control, placing the plaintext in the outbox payload makes the scan fail.

### R2 (2026-10-27): code principals are not login sessions

The lead resolves the conflict between activation from Invited and falsifier 2's Active-only sessions. Presenting a code yields a request-scoped principal narrowed to its command and resource; it is never stored as a Better Auth session. `activate` accepts it only from Invited, as the Account machine declares, and `resetPassword` only from Active. Every Better Auth session, including the one created after successful activation, passes the Active-only `session.create.before` guard. Falsifier 2 tests those login sessions separately from code principals: an activation code for an Active or Deactivated account and a reset code for an Invited or Deactivated account are refused byte-identically to a wrong password.

### R3 (2026-10-27): expired session reads

Better Auth 1.7.14 deletes an expired session on `getSession` even when `disableSessionRefresh` is enabled. Its `deferSessionRefresh` setting prevents that deletion on GET, so it is enabled as well and the HTTP session read is GET-only. Falsifier 5's refresh negative control disables both settings, allowing an overdue refresh to attempt its write. The read-only requirement is unchanged.

### R4 (2026-10-27): Better Auth cancellation boundary

The installed Better Auth pg/Kysely adapter takes no `AbortSignal`. The lead requires each library handler and API call to run to completion in an uninterruptible boundary: interruption is not reported while its foreign transaction may still commit. Domain commands retain their existing abort-and-rollback guarantee. An aborted sign-in may leave at most one session whose cookie the client did not receive; it is visible in the person's session list and expires normally, and no domain row changes. A registered exception retires when Better Auth forwards cancellation to its database adapter.

### R5 (2026-10-27): registry variant and stage secrets

The Better Auth UI registry's default URL redirects to `radix-nova`, but it also publishes a `base-nova` variant. The shadcn namespace explicitly selects that variant; the sign-in, session and password cards are adapted to this journey and use the registry's React hooks. Alchemy 2.0.0-beta.83 provides `makeRandom`, whose Redacted value is generated once and persisted per stage; deployed Workers bind that stage-specific signing secret. Only local development uses a fake signing key, and a missing or too-short key fails closed.

### R6 (2026-10-27): password change rotates the current session

Better Auth 1.7.14 implements `revokeOtherSessions` by deleting all sessions, creating a replacement for the current client, and returning its new cookie. The current client remains signed in with that cookie. All other sessions end, as required.

### R7 (2026-10-27): rate-limit buckets per auth route

The shared Worker binding permits five requests per minute. A single auth bucket also counts routine session reads, so it can block session revocation during the normal journey. Each Better Auth route now has its own per-IP bucket on that same binding. All library routes remain rate limited.

### R8 (2026-10-27): protect accounts during the Phase 1 import

PostgreSQL refuses the Phase 1 importer's truncate when the new account tables reference a person, even if those tables are empty. The importer names those tables under an exclusive transaction lock and refuses any target that already holds an account, code or auth user. It does not delete credentials or import accounts. Spec 0013 owns account migration.

### R9 (2026-10-27): Preview mail links use the stage URL

The earlier Preview configuration left `SITE_URL` empty because mail was only captured. Captured activation and reset messages still need usable links. Alchemy 2.0.0-beta.83 provides `Cloudflare.Worker.URL`, which binds each Worker's own public stage URL without a provisioning step. Preview uses that binding. Production keeps its explicitly configured origin.

### R10 (2026-10-27): check the signing key before Worker startup

Cloudflare exposes Worker bindings at module load through `cloudflare:workers`. The entry validates the signing key there, before it accepts a request. A workerd test starts the same validator with missing, short and valid keys. The first two fail startup without logging a key.

### R11 (2026-10-27): serialize Person account decisions

In preparation for spec 0006b's aggregate lock, Account commands concerning an identified person and code delivery take a `FOR NO KEY UPDATE` lock on the Person inside their transaction before final state decisions and guarded writes. Reset requests first identify a candidate, then recheck its private address and Active state after taking the lock. Account and Code writes each have one repository module, and Account state updates remain conditional. A 100-round PostgreSQL test proves the lock is held to transaction completion; the code-use and last-admin races run 300 rounds each.
