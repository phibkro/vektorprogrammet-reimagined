import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import { Array as Arr, pipe } from "effect";

const SECTIONS = [
  { label: "Oversikt", to: "/kontrollpanel" },
  { label: "Avdelinger", to: "/kontrollpanel/avdelinger" },
  { label: "Semestre", to: "/kontrollpanel/semestre" },
  { label: "Linjer", to: "/kontrollpanel/linjer" },
  { label: "Statisk innhold", to: "/kontrollpanel/statisk-innhold" },
  { label: "Artikler", to: "/kontrollpanel/artikler" },
  { label: "Sponsorer", to: "/kontrollpanel/sponsorer" },
  { label: "Arrangementer", to: "/kontrollpanel/arrangementer" },
] as const;

const ControlPanelLayout = () => (
  <main className="page-wrap grid gap-6 px-4 py-10 md:grid-cols-[12rem_1fr]">
    <nav aria-label="Kontrollpanel" className="flex flex-col gap-2 text-sm">
      {pipe(
        SECTIONS,
        Arr.map((section) => (
          <Link
            key={section.to}
            to={section.to}
            activeOptions={{ exact: true }}
            activeProps={{ className: "font-bold" }}
          >
            {section.label}
          </Link>
        ))
      )}
    </nav>
    <div className="grid content-start gap-6">
      <Outlet />
    </div>
  </main>
);

/**
 * Staff control panel. Phase 1 has no login: authority is decided inside each
 * command's transaction (deny by default), so outside a local deployment
 * every write here is refused with 403.
 */
export const Route = createFileRoute("/kontrollpanel")({
  component: ControlPanelLayout,
});
