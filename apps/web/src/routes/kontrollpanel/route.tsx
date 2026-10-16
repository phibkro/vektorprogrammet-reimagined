import {
  Link,
  Outlet,
  createFileRoute,
  useRouterState,
} from "@tanstack/react-router";
import { Array as Arr, pipe } from "effect";

import { Button } from "@/components/ui/button";

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

const ControlPanelLayout = () => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <main className="page-wrap grid gap-6 px-4 py-10 md:grid-cols-[13rem_1fr]">
      <nav aria-label="Kontrollpanel" className="flex flex-col gap-1">
        {pipe(
          SECTIONS,
          Arr.map((section) => (
            <Button
              key={section.to}
              variant={pathname === section.to ? "secondary" : "ghost"}
              size="sm"
              nativeButton={false}
              className="justify-start"
              render={<Link to={section.to} activeOptions={{ exact: true }} />}
            >
              {section.label}
            </Button>
          ))
        )}
      </nav>
      <div className="grid content-start gap-6">
        <Outlet />
      </div>
    </main>
  );
};

/**
 * Staff control panel. Phase 1 has no login: authority is decided inside each
 * command's transaction (deny by default), so outside a local deployment
 * every write here is refused with 403.
 */
export const Route = createFileRoute("/kontrollpanel")({
  component: ControlPanelLayout,
});
