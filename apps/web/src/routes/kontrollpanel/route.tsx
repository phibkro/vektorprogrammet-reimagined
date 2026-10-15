import { Link, Outlet, createFileRoute } from "@tanstack/react-router";

const SECTIONS = [
  { to: "/kontrollpanel", label: "Oversikt" },
  { to: "/kontrollpanel/avdelinger", label: "Avdelinger" },
  { to: "/kontrollpanel/semestre", label: "Semestre" },
  { to: "/kontrollpanel/linjer", label: "Linjer" },
  { to: "/kontrollpanel/statisk-innhold", label: "Statisk innhold" },
  { to: "/kontrollpanel/artikler", label: "Artikler" },
  { to: "/kontrollpanel/sponsorer", label: "Sponsorer" },
  { to: "/kontrollpanel/arrangementer", label: "Arrangementer" },
] as const;

/**
 * Staff control panel. Phase 1 has no login: authority is decided inside each
 * command's transaction (deny by default), so outside a `local` deployment
 * every write here is refused with 403.
 */
export const Route = createFileRoute("/kontrollpanel")({
  component: ControlPanelLayout,
});

function ControlPanelLayout() {
  return (
    <main className="page-wrap grid gap-6 px-4 py-10 md:grid-cols-[12rem_1fr]">
      <nav aria-label="Kontrollpanel" className="flex flex-col gap-2 text-sm">
        {SECTIONS.map((section) => (
          <Link
            key={section.to}
            to={section.to}
            activeOptions={{ exact: true }}
            activeProps={{ className: "font-bold" }}
          >
            {section.label}
          </Link>
        ))}
      </nav>
      <div className="grid content-start gap-6">
        <Outlet />
      </div>
    </main>
  );
}
