# Spec 0003: Semesters by schedule

**Status:** frozen when PR opens; later changes are dated entries under [Revisions](#revisions) · **Phase:** 1 · **Source:** operator decision 2026-10-16 ("Semester creation could just be automated with a cron job instead of surfacing it as a human decision"), brief §7 "Product direction", Proposed revision 1.

## Journey

1. **Nobody creates semesters.** The current semester and the next one always exist as rows, written by the scheduled job, not by a person and not by a page view.
2. **An administrator** opens Semestre in the control panel and sees the semesters, newest first, with the current one marked. There is no create form.
3. **Every read is pure.** Opening any page (public or control panel) never writes to the database.

## Goal, constraints, values

- **Goal:** remove a human decision that has one correct answer, and remove the one place where a read writes (`apps/web/src/server/panel.ts` calls `ensureCurrentSemester` from three loaders).
- **Constraints:**
  - The job runs in the existing `scheduled` handler of the one Worker (`apps/web/src/server.ts`, cron `OUTBOX_SWEEP_CRON`). No new Worker, no Queue.
  - The write stays one statement per semester against the unique (term, year) constraint (`INSERT … ON CONFLICT … RETURNING`, spec 0001 R1); it is idempotent and safe under concurrent runs.
  - Semester windows stay RULE-022 (Europe/Oslo, half-open); `semesterForDate` stays the single source of "which semester is it".
  - Worker Previews run no crons (Cloudflare). A preview's rows come from its Neon fork of `dev`, where the base stage's cron wrote them. Local `vp dev` and tests run the job explicitly.
  - A read that needs "the current semester" uses the pure function; where it needs the row (an id), a missing row is a typed, visible state, never a hidden insert.
- **Values:** reads establish no edges back into the data; only commands and the job write.

## Behavior contract changes

| Rule | Before (spec 0001) | After |
| --- | --- | --- |
| RULE-237 | the current semester is created on demand when a page needs it | the scheduled job keeps the current and the next semester present; reads never create rows |
| RULE-144 | an administrator creates a semester; a duplicate is refused | no manual creation: the create form and its server function are removed. Proposed revision recorded in the brief §7 (2026-10-16) |

## Falsifiers (definition of done)

1. On an empty semester table, one job run leaves exactly the current and the next semester; a second run changes nothing; 20 concurrent runs still leave exactly two rows (real PostgreSQL).
2. Boundaries: at 2026-07-31T23:59:59 Europe/Oslo the job ensures Vår 2026 and Høst 2026; at 2026-08-01T00:00:00 it ensures Høst 2026 and Vår 2027.
3. Every public and control-panel read path succeeds against a database role that has SELECT only. This proves no read writes.
4. The Semestre page lists semesters with no create form, and no server function that creates a semester exists any more.
5. The browser journey covers the new Semestre page; CI is green, and the pull request's Worker Preview serves the page.

## Revisions
