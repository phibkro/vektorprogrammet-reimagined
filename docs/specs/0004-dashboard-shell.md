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
