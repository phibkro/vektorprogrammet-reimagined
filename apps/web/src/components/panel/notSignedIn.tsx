import { Link } from "@tanstack/react-router";

import { TestActorSwitch } from "@/components/panel/testActorSwitch";

/**
 * What `/kontrollpanel` shows a visitor who is not signed in: a plain page, no sidebar, no navigation and no link
 * to any control-panel page. The test-actor switch appears only where it works (a local deployment).
 */
export const NotSignedIn = ({
  testActors,
}: {
  testActors: readonly string[] | null;
}) => (
  <main className="mx-auto grid min-h-svh w-full max-w-md content-center gap-4 px-4 py-12">
    <h1 className="text-2xl font-semibold tracking-tight">Ikke innlogget</h1>
    <p>Du må være innlogget for å bruke kontrollpanelet.</p>
    <p>
      <Link to="/logg-inn">Logg inn</Link>
    </p>
    <p>
      <Link to="/">Til forsiden</Link>
    </p>
    {testActors !== null && <TestActorSwitch people={testActors} />}
  </main>
);

/**
 * What `/kontrollpanel` shows a person who is signed in but belongs to no team and holds no admin place: nothing
 * of the panel (no sidebar, no link), because nothing is granted. Nobody assigns a role: the page follows the
 * memberships.
 */
export const NoSections = ({
  name,
  testActors,
}: {
  name: string;
  testActors: readonly string[] | null;
}) => (
  <main className="mx-auto grid min-h-svh w-full max-w-md content-center gap-4 px-4 py-12">
    <h1 className="text-2xl font-semibold tracking-tight">Ingen tilgang</h1>
    <p>
      {name} er ikke medlem av noe team akkurat nå, så kontrollpanelet har ingen
      sider for deg.
    </p>
    <p>
      <Link to="/min-side">Gå til Min side</Link>
    </p>
    <p>
      <Link to="/">Til forsiden</Link>
    </p>
    {testActors !== null && <TestActorSwitch people={testActors} />}
  </main>
);
