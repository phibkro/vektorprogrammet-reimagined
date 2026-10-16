import { Link } from "@tanstack/react-router";

import { TestActorSwitch } from "@/components/panel/testActorSwitch";

/**
 * What `/kontrollpanel` shows a visitor who is not signed in: a plain page, no sidebar, no navigation and no link
 * to any control-panel page. The test-actor switch appears only where it works (a local deployment).
 */
export const NotSignedIn = ({ testActors }: { testActors: boolean }) => (
  <main className="mx-auto grid min-h-svh w-full max-w-md content-center gap-4 px-4 py-12">
    <h1 className="text-2xl font-semibold tracking-tight">Ikke innlogget</h1>
    <p>Du må være innlogget som ansatt for å bruke kontrollpanelet.</p>
    <p>
      <Link to="/">Til forsiden</Link>
    </p>
    {testActors && <TestActorSwitch />}
  </main>
);
