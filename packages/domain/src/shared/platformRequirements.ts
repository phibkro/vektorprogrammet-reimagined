/**
 * What the domain asks of a platform (spec 0025, ADR 0014): for each capability, the properties that a store adapter
 * must show on the platform it runs on, or why none can be shown there.
 *
 * A guarantee (`guarantees.ts`) is a property of an abstract store. Whether it still holds when a pooler sits between
 * the Worker and the database is a fact of the platform, and only the platform can show it. This is the list of what it
 * must show: an id, the guarantee that the check protects, and the property in the domain's words (no statement, no
 * table, no engine feature). The adapter runs each check with the constructs it really uses (`PlatformProbe`), and
 * `platformProblems` is the one statement of what a report must hold: a check that is absent fails as surely as one that
 * is false, so a report cannot pass by leaving a check out.
 *
 * `PlatformRequirements` is keyed by every `Capability`, so a capability added to ADR 0014's closed set does not compile
 * until it says what a platform must show or why nothing can be shown. A capability that is not probed says why, in the
 * domain's words; where it was measured (and where it was not) is the adapter's to say, because the evidence names the
 * engine and its tests.
 */
import { Array as Arr, Predicate, Record as Rec } from "effect";

import type { Capability } from "./guarantees.ts";
import type { PlatformReport } from "./platformProbe.ts";

/** One property that a platform must show, and the guarantee that it protects. */
export interface RequiredCheck {
  readonly id: string;
  /** The id of a guarantee in `guarantees.ts` (a test reads both). */
  readonly guarantee: string;
  readonly property: string;
}

/** A capability whose properties a deployed probe shows. */
export interface ProbedRequirement {
  readonly checks: readonly [RequiredCheck, ...RequiredCheck[]];
  /** A guarantee of the capability that another port shows, and which port. */
  readonly shownElsewhere?: string;
}

/** A capability that a deployed probe cannot show. */
export interface NotProbedRequirement {
  /** Why a deployed probe does not show it. */
  readonly reason: string;
}

export type CapabilityRequirement = ProbedRequirement | NotProbedRequirement;

export const isProbed = (
  requirement: CapabilityRequirement
): requirement is ProbedRequirement =>
  Predicate.hasProperty(requirement, "checks");

export const PlatformRequirements: Readonly<
  Record<Capability, CapabilityRequirement>
> = {
  AggregateLocks: {
    checks: [
      {
        guarantee: "LK1",
        id: "lock-excludes-second-holder",
        property:
          "While one transaction holds a record's lock, a second request for the same lock does not get it.",
      },
      {
        guarantee: "LK1",
        id: "lock-ends-with-its-transaction",
        property:
          "When the holder's transaction ends, the lock is free for the next request, on whichever connection that request comes.",
      },
    ],
  },
  AnalyticsReads: { reason: "No store serves it yet." },
  Claims: {
    reason:
      "Showing one winner takes a committed record, and a probe on a Preview leaves none.",
  },
  ConditionalWrites: {
    reason:
      "A conditional write is one step that the store judges at its newest committed state, and a probe needs a committed record to show it.",
  },
  Leases: { reason: "It is made of claims and conditional writes." },
  NonOverlap: {
    reason:
      "The store's own constraint decides it, and a probe needs a committed record to show it.",
  },
  ObjectStore: {
    reason: "No pooler sits between the Worker and the object store.",
  },
  ReadOnlyReads: {
    reason:
      "It is a property of the role and of the reads, shown by a role that can only read.",
  },
  Snapshots: {
    reason:
      "A snapshot is one read, and a probe cannot tell it from another read on one connection.",
  },
  Transactions: {
    checks: [
      {
        guarantee: "TX1",
        id: "rollback-leaves-nothing",
        property:
          "A transaction that is rolled back leaves none of its writes visible, to the connection that wrote them or to another.",
      },
      {
        guarantee: "TX2",
        id: "nested-scope-undoes-alone",
        property:
          "A nested scope that fails undoes its own writes, and the enclosing scope keeps what it wrote.",
      },
    ],
    shownElsewhere:
      "TX3, the isolation floor, is shown by `IsolationProbe` (spec 0018 R10).",
  },
  UniqueKeys: {
    reason:
      "The store's own key constraints decide it, and a probe needs a committed record to show it.",
  },
  WorkQueue: {
    checks: [
      {
        guarantee: "LS1",
        id: "held-record-is-not-handed-on",
        property:
          "A record that one transaction holds is skipped by a second claimer: it is not waited for and not handed out again while the first transaction holds it.",
      },
    ],
  },
};

/** The checks that a platform must show, in the order of the declaration. */
export const requiredChecks: readonly RequiredCheck[] = Arr.flatMap(
  Rec.values(PlatformRequirements),
  (requirement) => (isProbed(requirement) ? requirement.checks : [])
);

/**
 * Why a report is not what the domain asks of a platform; empty when it is. Total and pure: a required check that the
 * report leaves out fails, a check that did not hold fails (with what it observed), and a check that the adapter adds of
 * its own fails when it did not hold. The checks of a platform are all or nothing.
 */
export const platformProblems = (report: PlatformReport): readonly string[] => {
  const reported = new Set(Arr.map(report.checks, (check) => check.id));

  const missing = Arr.map(
    Arr.filter(requiredChecks, (required) => !reported.has(required.id)),
    (required) =>
      `the check "${required.id}" (${required.guarantee}) is not in the report: ${required.property}`
  );

  const failed = Arr.map(
    Arr.filter(report.checks, (check) => !check.held),
    (check) => `the check "${check.id}" did not hold: ${check.detail}`
  );

  return [...missing, ...failed];
};
