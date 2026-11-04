# 0024 — One Start application and Supabase

Status: implemented and exercised locally. Operator request: 2026-11-04.

## Goal

Run the Vektorprogrammet prototype with one TanStack Start Cloudflare Worker and one Supabase project (Postgres, Auth, Storage). Replace infrastructure integrations rather than rebuild working domain behavior. Prefer maintained ecosystem libraries and official examples over general-purpose application machinery.

## User journey and acceptance

- A visitor reads public pages, published news and sponsors without a CMS process.
- A synthetic seeded administrator signs in through real Supabase Auth, reaches the existing control panel, edits organisation/team data and observes persisted results after refresh.
- A seeded department leader cannot read or mutate another department's restricted data. Current account state and domain permissions remain authoritative.
- Account sign-in, sign-out, recovery and personal settings use Supabase, not a second authentication library.
- An authorized editor saves draft content and publishes it through the same application; draft edits cannot leak to visitors.
- Public files are stored in real Supabase Storage and served through the existing registry and safe-header route. Private storage is not anonymously readable.
- Domain changes, audit and outbox intent remain transactional. One scheduled Worker entry point recovers and delivers pending outbox work without a Cloudflare Queue service.
- A documented repeatable local setup creates only synthetic data and starts the real application and Supabase services. Browser verification exercises the changed seams; a production build targets workerd.

## Architecture contract

One application runtime: apps/web. Existing domain and Postgres adapters remain shared libraries. No new API service, CMS service, queue service, realtime layer or generic framework. Supabase SDK handles Auth and Storage; @supabase/ssr handles cookies. Database commands use existing transactional PostgreSQL access rather than sequences of Data API calls.

Runtime configuration names: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, DATABASE_URL, SITE_URL, DEPLOYMENT. Secret key and database URL are server-only runtime bindings. No secrets in build output or browser bundles. Supabase domain data is not exposed for direct browser writes. Auth identities link to existing numeric people through trusted administrator-owned app metadata or a unique mapping, never user-editable metadata. Active-account checks execute against current domain state.

Content remains Portable Text to preserve existing rendering and import rules. Content editing is inside the existing control panel, with draft/published separation. File registry remains authoritative, with private provider buckets. Outbox remains the durable record, with bounded due claims, retries and lease fencing; provider calls occur after commit.

## Constraints and authority

No production deployment, remote project creation, copying production files/data, live email/SMS/Google writes, or credential changes. Local synthetic users and disposable service credentials are allowed. Production migration and password compatibility require separate cutover evidence, not implied by this prototype. Existing unfinished recruitment/placement functionality is not claimed complete by an infrastructure migration.

## Reuse and provenance

The existing Start application remains the scaffold. The official TanStack Supabase example informed the integration. `apps/web/src/server/supabase.ts` records the adapted Supabase Library cookie bridge, source URL and Apache-2.0 provenance.

Official Supabase SDKs handle Auth and Storage. The maintained Portable Text editor reuses the existing content model. Existing React/shadcn components, Effect domain rules and Drizzle transactions remain. Unused example dependencies and unrelated Library blocks were not installed.

## Verification record

Verification ran against the integrated working tree and synthetic local services. It is not a hosted-release or production-migration claim.

| Journey | Observed result |
| --- | --- |
| Real sign-in | Administrator and ordinary-account credentials reached the control panel and Min side respectively on the running frontend. |
| Direct Data API | Anonymous and authenticated clients saw no domain rows. Inserts failed with SQLSTATE 42501 (HTTP 401/403). Privileged control reads/inserts succeeded. |
| Pre-hydration privacy | The no-JavaScript regression failed before. After the fix, submit stayed disabled and forced native submission sent POST without credentials in the URL. |
| Organisation persistence | A department created through the UI remained after refresh. |
| Content publication | Draft edits stayed private. Publication changed the public homepage and survived refresh. |
| Restricted editor | The department leader received HTTP 403 for the editor route. |
| Storage | After RLS, native Auth, privileged private-Storage read and registry download still worked. The download matched its content hash. Anonymous bucket access failed. |
| Native account lifecycle | A fresh invitation activated. Recovery changed the password. Token replay failed. |
| Personal data | Export omitted credential/token fields. Erasure refused later sign-in. Provider deletion reached delivered status and removed the synthetic identity. |
| Scheduled jobs | The real local scheduled endpoint returned `ok`. SQL recorded completed semester, alumni-consent and outbox runs. |
| Legacy public files | Signed-in access initially returned 500. The public-only composition root fixed it. The browser regression passed anonymous and signed-in redirects. |
| Final compiled Worker | Real sign-in, draft/save/publish/restore and legacy redirects passed. SSR included content entries. Fresh editor navigation produced no page errors. The leader received 403. |

| Check | Exercised result |
| --- | --- |
| `prototype:setup` | Repeated migration, synthetic seed, Auth mapping and private-bucket setup succeeded without resetting edited content. |
| `test:all` | The integration baseline passed all 10 workspace units: 1,213 tests. It preceded the final UI and RLS fixes. |
| Browser modules | Delegated isolated runs reported 60 passing cases across public, account, shell, team, privacy and integration journeys. The lead independently exercised the critical journeys above. |
| Compiled browser regressions | The editor and pre-hydration regressions failed before their fixes. Both and the legacy-file case passed on the final compiled Worker: 3 passed. |
| Post-RLS SQL/Auth | Four database files passed 17 tests. Read-only request and native cookie files passed 4 tests. The SQLSTATE-specific security case also passed its final rerun. |
| Worker build | Production build succeeded. Vite emitted its CSS sourcemap warning. The built Worker and editor ran in Chromium. |
| Terraform | `init -backend=false -input=false` and `validate` succeeded with pinned official providers. No remote import, plan or apply ran. |
| Source quality | Format/lint/type checks, Knip, exception registry, store boundary, module graph and generated-document checks passed. Duplication check reported zero clones. |
| Source secret scan | Gitleaks scanned the complete candidate patch through an isolated temporary Git index and reported no leaks. The ordinary index remained unchanged. |
| Conformance | Description/vector regeneration succeeded with the pinned effx revision. Workspace conformance tests passed. |
| Membership model | Reran after the RLS migration. Model/negative variants matched expected outcomes and 53 repository checks passed. The uncommitted-covered-files warning remains. |

The full workspace suite was not repeated after the final UI/RLS changes. Those changes passed focused SQL/Auth, native Data API, compiled-browser and model/code checks.

The membership model does not prove RLS or external provider workflows. SQL fixtures do not replace native API/browser evidence. Hosted deployment, real messages and production data/password/file migration remain unauthorized. Test stacks and databases were stopped after verification. The interactive prototype and its local Supabase services remain available.

## Revisions

- 2026-11-04: Initial executable contract, based on existing source seams and operator's simplification request. Local runtime availability being investigated without privileged host changes.
- 2026-11-04: Use Supabase-native invitation/recovery/password management instead of preserving a second credential/code delivery framework. Keep domain account states and authorization; session controls expose supported local/other/all sign-out rather than claiming arbitrary session revocation. Legacy passwords and sessions are not migrated in this synthetic prototype.
- 2026-11-04: Operator selected Terraform for Supabase provisioning. Deployment configuration will use official providers with explicit Worker artifact ownership; no remote apply is authorized.
- 2026-11-04: Arbitrary editorial content requires explicit manual privacy review handling, not a fabricated automatic retention/person-key declaration.
- 2026-11-04: Local Supabase CLI uses publicly shared development credentials and publishes ports beyond loopback under this container setup. Synthetic data only; this is not a secured production environment.
- 2026-11-04: Public legacy redirects use only the registry database layer. They require no authenticated principal or Start cookie context. A real signed-in 500 established the regression before the fix.
- 2026-11-04: Final checks removed stale source/export-list assertions and an exact duplicate outbox test. Permission tests now include the administrator-only content section. Shared draft encoding and transactional claim acknowledgment remove duplicate implementation code without changing their boundaries.
- 2026-11-04: A login submitted before hydration exposed the browser's default GET behavior. All JavaScript-owned forms now declare POST and use TanStack useHydrated to block premature submission. Native activation/export/contact forms keep their existing POST flows. Add a no-JavaScript browser regression for button state and forced native request transport.
- 2026-11-04: Native Data API inspection found default anonymous grants on 25 domain tables without RLS. The shared Drizzle table factory now enables RLS by default, with no browser-role policies. Generate and apply the matching migration. The database regression closes over migrated public tables and uses broad grants plus an RLS-disabled negative control. Read-only test roles derive their SELECT policies from the actual RLS tables. The Worker requires an owner/BYPASSRLS server connection. Native Auth/Storage schemas remain unchanged. Live catalog inspection found no exposed definer-function or view bypass.
- 2026-11-04: The compiled Worker exposed a Portable Text import-time random-key error during SSR. Load only the browser editor through React lazy and TanStack ClientOnly. Keep server rendering and authorization for the protected route. Extend the existing draft/publish browser journey to reject page errors, and exercise it against the compiled Worker.
