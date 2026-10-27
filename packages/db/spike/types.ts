/** Type-level probes: are generated columns typed, and what do relation results look like? */
import { Effect } from "effect";

import { Rqb } from "./harness.ts";

export const probe = Effect.gen(function* probe() {
  const rqb = yield* Rqb;
  const row = yield* rqb.query.membership.findFirst({ with: { person: true, team: true } });
  if (row === undefined) {
    return;
  }
  // Generated column typing: `number | null` or `number`?
  const start: number = row.startOrdinal;
  const end: number = row.endOrdinal;
  // `optional: false` relations: `person` is not nullable?
  const name: string = row.person.name;
  const teamName: string = row.team.name;

  return { end, name, start, teamName };
});
