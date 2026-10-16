# Spec 0004: The control panel as a dashboard

**Status:** frozen when PR opens; later changes are dated entries under [Revisions](#revisions) · **Phase:** 1 · **Source:** operator decisions 2026-10-16 (brief §7 "Product direction", Proposed revisions 2 and 3): "better to just not show a capability outright if its inaccessible to the user"; "Dashboard should use shadcn sidebar and look like a pretty generic dashboard application with sidebar navigation, main content in the middle, possibly a sliding detail modal or sidebar … for when inspecting things or filling out forms."

## Journey

1. **A staff member** opens `/kontrollpanel` and sees a generic dashboard: a shadcn Sidebar on the left (sections grouped, the current one highlighted, collapsible to icons), a header with breadcrumbs and the sidebar toggle, and the page in the main area.
2. The sidebar lists **only the sections the actor may use**. Every action on a page (create, edit, publish, delete) exists in the page only when the actor holds that capability.
3. **Inspecting or editing a record** opens a Sheet that slides in from the right with the record's details or its form. Saving closes the Sheet, and the table shows the change. Cancel and Escape close it and return focus to what opened it.
4. **An anonymous visitor** sees no control panel: no link to it anywhere, and `/kontrollpanel` shows a plain "not signed in" page without navigation.
5. On a phone-sized screen the sidebar becomes an off-canvas panel.

## Goal, constraints, values

- **Goal:** the control panel looks and behaves like a standard admin dashboard, and shows each actor exactly what they can do.
- **Constraints:**
  - shadcn/ui on Base UI (`base-nova`): add `sidebar`, `sheet`, `breadcrumb` and whatever they pull in with `shadcn add`, then `bun add` any dependency it names (repo `AGENTS.md`).
  - Precedent: mono-web `apps/dashboard/app/routes/dashboard.tsx` (Sidebar + Sheet layout) and `apps/dashboard/app/foldkit/dashboard/shell.ts` (navigation filtered by authority, each destination still enforcing it). Reuse the layout ideas, not its Radix imports.
  - **What is shown derives from the same capability function the server enforces** (`packages/domain` capabilities). There must be no second, hand-kept list of who may do what. The server still refuses (403) every forged request: hiding is presentation, not authority.
  - Spec 0003 (semesters by schedule) removes the semester create form on a parallel branch. Leave the Semestre page's create form as it is; whichever branch lands second rebases.
  - The public site is unchanged in this spec (a later spec moves it to Astro + EmDash).
- **Values:** the bad state "a button the actor can't use" is not rendered at all, rather than rendered and refused.

## Falsifiers (definition of done)

1. Browser tests per actor: the administrator sees every section; the team leader sees only the sections its capabilities allow; an anonymous visitor sees no control-panel navigation or link, and `/kontrollpanel` renders the not-signed-in page.
2. For every control-panel page, the controls for a capability the actor lacks are absent from the DOM (team leader and administrator compared).
3. Spec 0001's falsifier 5 stays green: a forged request for a hidden capability still gets HTTP 403 and changes nothing.
4. Create and edit happen in a right-hand Sheet: a saved edit appears in the table without a full page reload; Escape closes the Sheet and focus returns to the opening control.
5. At 1280 px the sidebar collapses to icons and back; at 390 px it opens as an off-canvas panel. The PR carries screenshots of both.
6. One source: a unit test proves the navigation entries and page actions are computed from the domain capability function (changing a capability in the test actor changes what is rendered).
7. CI is green (checks and browser tests), and the pull request's Worker Preview is deployed.

## Revisions

The spec is frozen when its pull request opens. Each entry below names the old text, the new text and the reason; a later change needs a new dated entry.

### R1 — Spec 0003 landed first: the Semestre page is a list (2026-10-16)

- **Was:** "Spec 0003 (semesters by schedule) removes the semester create form on a parallel branch. Leave the Semestre page's create form as it is; whichever branch lands second rebases."
- **Now:** spec 0003 merged first (`72e5be3`). There is no create form, no `createSemester` and no `ManageSemesters` capability. This branch rebased onto it and took 0003's list-only page into the shell. Semestre appears in the sidebar for every staff member, because no capability gates it, and its page has no gated control.
- **Why:** the rebase the spec asked for. The `ManageSemesters` entry the sidebar had for that section is gone with the capability, so "a section that lists no capability is for any staff member" is now the rule for Oversikt and Semestre.

### R2 — Inspect is a read-only Sheet for what the actor may not edit (2026-10-16)

- **Was:** "Inspecting or editing a record opens a Sheet … with the record's details or its form", without saying who gets which.
- **Now:** on a department's row, an actor who holds `UpdateDepartment` for it gets the edit form ("Rediger"); any other staff member gets the department's details in a read-only Sheet ("Vis"). Every other table's records show all their fields in the row, so they have no read-only Sheet.
- **Why:** the details Sheet is how a team leader inspects another department, which the page lists but the leader may not change. Which of the two opens is derived from the same `authorize` call as every other control.

### R3 — The control panel owns the page; the public site stays unchanged (2026-10-16)

- **Was:** not stated: the shell could have sat inside the public header and footer, and "no link to it anywhere" assumed there might be links to remove.
- **Now:** `/kontrollpanel` renders without the public header and footer (the route sets `staticData.ownsPage`, which the root layout reads). The not-signed-in page is plain: no header, no footer, no sidebar, no link to a control-panel page. The public header and footer had no control-panel link and get none, for any actor.
- **Why:** a generic dashboard owns the whole viewport. No public page changed (`a` styles are scoped away from shadcn components with `:where(:not([data-slot]))`, which keeps the specificity of plain `a`).

### R4 — The sidebar's state is not kept across a reload (2026-10-16)

- **Was:** "collapsible to icons" only.
- **Now:** the sidebar collapses and expands while the layout stays mounted. shadcn's cookie (written, never read by this app) was removed, so a full reload starts expanded.
- **Why:** a cookie nobody reads is dead code. Persisting it is a server read of that cookie before first paint; no falsifier needs it.

### R5 — The test-actor switch moved with the not-signed-in page (2026-10-16)

- **Was:** the switch lived on the overview.
- **Now:** it appears on the overview and on the not-signed-in page, and only when `DEPLOYMENT` is `local` (the shell data carries that fact). Without it, an anonymous test actor on a local deployment would have no way back.
- **Why:** the plain not-signed-in page has no other control, and the switch has no meaning outside `local`.
