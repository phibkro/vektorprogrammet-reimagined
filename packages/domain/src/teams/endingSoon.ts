/**
 * The "ending soon" digest (ADR 0002, spec 0006, falsifier 7). Four weeks before a semester ends, each team leader
 * gets one e-mail that lists the memberships of their department that end in it, each with a link to extend it. Nothing
 * continues by itself, so this is how a leader hears that a term is about to lapse.
 *
 * `planDigests` and `digestEmail` are pure. `runEndingSoon` is the job (`System("endingSoon")`): it runs on every cron
 * tick, does nothing outside the last four weeks, and records one ledger row per leader and semester, so the
 * message goes out once however often the job runs (the ledger row and the outbox row commit together).
 */
import { Array as Arr, DateTime, Effect, Order, Record as Rec } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";

import { recordAudit } from "../audit/auditLog.ts";
import type { Principal } from "../kernel/principal.ts";
import {
  inLastWeeksOf,
  semesterForDate,
  semesterLabel,
} from "../organisation/semester.ts";
import type { Semester } from "../organisation/semester.ts";
import type { DepartmentId, PersonId } from "../shared/ids.ts";
import { EmailMessage, Outbox } from "../shared/outbox.ts";
import type { DeclaredMessage } from "../shared/outbox.ts";
import { SiteOrigin } from "../shared/siteOrigin.ts";
import { InTransaction } from "../shared/transaction.ts";
import { MembershipRepository, DigestLedger } from "./services.ts";
import type { ActiveMembership } from "./services.ts";
import { semesterOrdinal } from "./term.ts";

/** How long before the end of the semester the digest goes out, in weeks. */
export const ENDING_SOON_WEEKS = 4;

/** Whether `now` is in the last four weeks of `semester` (the Oslo calendar), the end instant excluded. */
export const isEndingSoon = (
  semester: Semester,
  now: DateTime.DateTime
): boolean => inLastWeeksOf(semester, ENDING_SOON_WEEKS, now);

/** One leader's digest: the memberships that end in the semester, in the departments the leader leads. */
export interface Digest {
  readonly leader: {
    readonly email: ActiveMembership["personEmail"];
    readonly name: string;
    readonly personId: PersonId;
  };
  readonly items: NonEmptyReadonlyArray<ActiveMembership>;
}

const byTeamThenPerson = Order.combine(
  Order.mapInput(
    Order.String,
    (membership: ActiveMembership) => membership.teamName
  ),
  Order.mapInput(
    Order.String,
    (membership: ActiveMembership) => membership.personName
  )
);

/**
 * The digests of `semester`, one per leader who has something to read, ordered by person id. `active` holds the
 * memberships active in `semester`; a leader is a person with an active membership that has the leader flag, and
 * a membership ends in `semester` when its end is `semester`.
 */
export const planDigests = (
  active: readonly ActiveMembership[],
  semester: Semester
): readonly Digest[] => {
  const ending = Arr.filter(
    active,
    (membership) =>
      semesterOrdinal(membership.end) === semesterOrdinal(semester)
  );

  const leading = Arr.groupBy(
    Arr.filter(active, (membership) => membership.leader),
    (membership) => String(membership.personId)
  );

  return Arr.sort(
    Arr.flatMap(Rec.values(leading), (memberships) => {
      const [first] = memberships;

      const departments: readonly DepartmentId[] = Arr.map(
        memberships,
        (membership) => membership.departmentId
      );

      const items = Arr.sort(
        Arr.filter(ending, (membership) =>
          Arr.contains(departments, membership.departmentId)
        ),
        byTeamThenPerson
      );

      return first !== undefined && Arr.isReadonlyArrayNonEmpty(items)
        ? [
            {
              items,
              leader: {
                email: first.personEmail,
                name: first.personName,
                personId: first.personId,
              },
            },
          ]
        : [];
    }),
    Order.mapInput(Order.Number, (digest: Digest) => digest.leader.personId)
  );
};

/** The link that opens the team's page with the extend form of the membership. */
export const extendLink = (
  origin: string,
  membership: Pick<ActiveMembership, "id" | "teamId">
): string =>
  `${origin}/kontrollpanel/team/${membership.teamId}?forleng=${membership.id}`;

/** The e-mail of one digest (Norwegian, like every message the system sends). */
export const digestEmail = (
  digest: Digest,
  semester: Semester,
  origin: string
): DeclaredMessage =>
  EmailMessage.make({
    replyTo: null,
    subject: `Medlemskap som slutter i ${semesterLabel(semester)}`,
    text: Arr.join(
      [
        `Hei ${digest.leader.name},`,
        "",
        `Disse medlemskapene i avdelingen din slutter i ${semesterLabel(semester)}. Ingenting fortsetter av seg selv: hvis noen skal fortsette, må du forlenge medlemskapet.`,
        "",
        ...Arr.flatMap(digest.items, (membership) => [
          `- ${membership.personName}, ${membership.teamName} (${membership.positionName}), til og med ${semesterLabel(membership.end)}`,
          `  Forleng: ${extendLink(origin, membership)}`,
        ]),
        "",
        "Vennlig hilsen",
        "Vektorprogrammet",
      ],
      "\n"
    ),
    to: digest.leader.email,
  });

/**
 * The job. Inside the last four weeks of the current semester it claims the ledger row of each leader with
 * something to read (`DigestLedger.claim`: the second run finds the row and sends nothing) and enqueues that
 * leader's e-mail in the same transaction. Outside the window it does nothing.
 */
export const runEndingSoon = (principal: Principal) =>
  Effect.gen(function* run() {
    yield* InTransaction;
    const now = yield* DateTime.now;
    const semester = semesterForDate(now);

    if (!isEndingSoon(semester, now)) {
      return { sent: 0 };
    }

    const memberships = yield* MembershipRepository;
    const ledger = yield* DigestLedger;
    const outbox = yield* Outbox;
    const origin = yield* SiteOrigin;

    const digests = planDigests(
      yield* memberships.activeIn(semester),
      semester
    );

    const sent = yield* Effect.forEach(digests, (digest) =>
      Effect.gen(function* sendDigest() {
        if (!(yield* ledger.claim(digest.leader.personId, semester))) {
          return 0;
        }

        yield* outbox.enqueue([digestEmail(digest, semester, origin)]);
        yield* recordAudit(
          principal,
          "endingSoon.sent",
          "Person",
          digest.leader.personId
        );

        return 1;
      })
    );

    return { sent: Arr.reduce(sent, 0, (total, one) => total + one) };
  });
