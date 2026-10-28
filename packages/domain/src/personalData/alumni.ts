/**
 * When a person has left (spec 0007b, journey 2): every membership has ended and at least one existed. The instant is the
 * end of the last one. These are pure rules over the memberships that a command read through the person's lock.
 */
import { Array as Arr, DateTime, Option } from "effect";

import { semesterWindow } from "../organisation/semester.ts";
import { isBefore } from "../shared/clock.ts";
import type { Membership } from "../teams/entities.ts";
import { Periods } from "./periods.ts";
import { afterDuration, lastActivityDue } from "./retentionEnd.ts";
import type { ActivityFacts } from "./retentionEnd.ts";

/** The instant at which a membership stops applying: the end of its end semester. */
const endsAt = (membership: Pick<Membership, "end">): DateTime.Utc =>
  semesterWindow(membership.end).end;

/**
 * The end of the last engagement when the person has left at `now`: at least one membership, and none that lasts past
 * `now` (an active or a planned one means they are still engaged). `None` otherwise.
 */
export const leftAt = (
  memberships: readonly Pick<Membership, "end">[],
  now: DateTime.Utc
): Option.Option<DateTime.Utc> => {
  const [first, ...rest] = Arr.map(memberships, endsAt);

  if (first === undefined) {
    return Option.none();
  }

  const last = Arr.reduce(rest, first, (latest, end) =>
    isBefore(latest, end) ? end : latest
  );

  return isBefore(now, last) ? Option.none() : Option.some(last);
};

/**
 * Whether an e-mail is still worth sending: the person's core is anonymised `Periods.personCore` after the engagement
 * ended, so a request after that would go to someone about to be anonymised (and `keepDetails` could not change that
 * in time).
 */
export const stillAsked = (
  leftAtInstant: DateTime.Utc,
  now: DateTime.Utc
): boolean =>
  isBefore(now, afterDuration(leftAtInstant, Periods.personCore.duration));

/**
 * Whether the alumni mail asks a person at `now` (spec 0021 R5): they have left (`leftAt`), the period of their last
 * activity (a valid admin place counts) is not over, and no request has been made for this engagement's end. This is the
 * selection that the repository used to make in the database over the view of a person's last activity.
 */
export const isAlumniCandidate = (
  facts: ActivityFacts,
  requestedEnds: readonly DateTime.Utc[],
  now: DateTime.Utc
): boolean =>
  Option.exists(
    leftAt(
      Arr.map(facts.memberships, (end) => ({ end })),
      now
    ),
    (last) =>
      !lastActivityDue(facts, { period: Periods.personCore }, false, now) &&
      !Arr.some(requestedEnds, (end) => DateTime.Equivalence(end, last))
  );
