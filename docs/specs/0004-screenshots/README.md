# Spec 0004 screenshots

`apps/web/e2e/shell.spec.ts` writes these files when `E2E_SCREENSHOT_DIRECTORY` names a directory. They show the real pages of `vp dev` on the migrated importer fixture, not mock-ups. From the repository root:

```sh
mkdir -p docs/specs/0004-screenshots
E2E_SCREENSHOT_DIRECTORY=$PWD/docs/specs/0004-screenshots devenv shell -- bun run e2e shell.spec.ts
```

| File | Shows | Written by |
| --- | --- | --- |
| `shell-1280-expanded.png` | the administrator at 1280 px, sidebar expanded | falsifier 5 (1280 px) |
| `shell-1280-collapsed.png` | the same page collapsed to icons; the hovered icon shows its label | falsifier 5 (1280 px) |
| `shell-1280-sheet.png` | the edit Sheet open on the right, the page dimmed behind it | falsifier 5 (1280 px) |
| `shell-390-closed.png` | a phone: no sidebar, the page owns the screen | falsifier 5 (390 px) |
| `shell-390-offcanvas.png` | a phone: the sidebar open as an off-canvas panel | falsifier 5 (390 px) |
| `departments-admin.png` | the administrator's departments page: "Ny avdeling" and "Rediger" on every row | falsifier 2 (admin) |
| `departments-teamLeader.png` | a team leader's: no "Ny avdeling", no "Statisk innhold" section, and "Vis" (details) on another department's row | falsifier 2 (teamLeader) |
