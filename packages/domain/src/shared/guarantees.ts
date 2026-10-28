/**
 * The store guarantees of the domain, written as properties of an abstract store (spec 0018, ADR 0014 stage 2).
 *
 * A guarantee is a sentence about records, keys, transactions and committed state: no statement, no table and no engine
 * feature. Each one names the capability it belongs to (ADR 0014, decision 1), its strength, whether it is an invariant
 * (a predicate of one committed state), the port methods that carry it, and what a raw writer would try to make it false.
 *
 * **Strength** is decided by one question: can a writer that writes valid data straight into the store, without the
 * port, make the property false for a program that uses the port? If the store refuses the write, or the property
 * survives it, it is `store-enforced`. If the writer succeeds, it is `port-enforced`. A property of reading is false
 * under no writer, so it is `store-enforced` too.
 *
 * **Invariants are store-enforced** (ADR 0014, answer 2). An invariant that the store cannot express may be
 * `port-enforced` only with a named `exception`, which says why and how the system recovers. `problemsOf` is the check.
 *
 * This declaration is the one place where a property is stated in full. The generated page renders it; the port comments,
 * `README.md` files and `AGENTS.md` cite a guarantee by its id (`TX3`) with at most a line of summary, and the contract
 * suites (stage 3) read it. The mechanism that an adapter uses today is never part of it.
 */
import { Array as Arr, Schema } from "effect";
import type { Context } from "effect";

import { CodeRepository } from "../accounts/codeRepository.ts";
import { AccountRepository } from "../accounts/services.ts";
import { AuditLog } from "../audit/auditLog.ts";
import { FileStore, PublicFileRepository } from "../files/services.ts";
import { JobRuns } from "../jobs/runs.ts";
import {
  DepartmentRepository,
  SemesterRepository,
} from "../organisation/services.ts";
import { CapturedMessageStore } from "../outbox/captured.ts";
import { OutboxDelivery } from "../outbox/delivery.ts";
import { OutboxReports } from "../outbox/status.ts";
import {
  AlumniRequests,
  ConsentRepository,
  LegalHolds,
  PersonalDataStore,
  RetentionRun,
} from "../personalData/services.ts";
import {
  AdminGrantRepository,
  DigestLedger,
  MembershipRepository,
  PersonRepository,
  PrincipalDirectory,
  TeamRepository,
  WelcomeLedger,
} from "../teams/services.ts";
import {
  WorkspaceAssignments,
  WorkspaceFacts,
  WorkspaceReports,
} from "../workspace/services.ts";
import { AggregateLocks } from "./aggregate.ts";
import { Outbox } from "./outbox.ts";
import { InTransaction } from "./transaction.ts";
import { TransactionModes } from "./transactionModes.ts";
import type { TransactionMode } from "./transactionModes.ts";
import { Transactor } from "./transactor.ts";

/** The capabilities of ADR 0014, decision 1. A closed set: a later stage adds rows, not names. */
export const Capability = Schema.Literals([
  "Transactions",
  "AggregateLocks",
  "UniqueKeys",
  "NonOverlap",
  "ConditionalWrites",
  "Claims",
  "Leases",
  "WorkQueue",
  "Snapshots",
  "ReadOnlyReads",
  "ObjectStore",
  "AnalyticsReads",
]);

export type Capability = typeof Capability.Type;

/** `store-enforced`: it holds against every writer. `port-enforced`: only against writers that use the port. */
export const Strength = Schema.Literals(["store-enforced", "port-enforced"]);

export type Strength = typeof Strength.Type;

/** A port, and the method of it that carries a guarantee; `null` when the whole port does (`InTransaction`). */
export const Carrier = Schema.Struct({
  method: Schema.NullOr(Schema.String),
  port: Schema.String,
});

export type Carrier = typeof Carrier.Type;

/** Why an invariant is port-enforced, and how the system recovers when it fails anyway. */
export const Exception = Schema.Struct({
  reason: Schema.String,
  recovery: Schema.String,
});

export type Exception = typeof Exception.Type;

/** The class name of a port from its service key: `@vektorprogrammet/domain/shared/Outbox` is `Outbox`. */
export const portNameOf = (key: string): string => key.split("/").at(-1) ?? key;

export const GuaranteeId = Schema.String.check(
  Schema.isPattern(/^[A-Z]{2}\d$/u, { expected: "an id such as TX1" })
);

export const Guarantee = Schema.Struct({
  capability: Capability,
  carriers: Schema.Array(Carrier),
  /** Present only on an invariant that is `port-enforced` (ADR 0014, answer 2). */
  exception: Schema.optionalKey(Exception),
  id: GuaranteeId,
  /** A predicate of one committed state, as against a rule about operations or histories. */
  invariant: Schema.Boolean,
  property: Schema.String,
  /** What a raw writer tries, and what happens: the case that stage 3 turns into the test of the strength. */
  rawWriter: Schema.String,
  strength: Strength,
  /**
   * The carriers whose writes the guarantee spans (a claim and the message it guards, a chunk and its cursor): each is a
   * carrier of the guarantee and is `Requires` in `TransactionModes`, so its type says what the property assumes.
   */
  transactional: Schema.optionalKey(Schema.Array(Carrier)),
});

export type Guarantee = typeof Guarantee.Type;

/** A promise that the domain does not make, stated so that nobody relies on it. */
export const NonGuarantee = Schema.Struct({
  carriers: Schema.Array(Carrier),
  id: GuaranteeId,
  statement: Schema.String,
});

export type NonGuarantee = typeof NonGuarantee.Type;

/** A method of a port by the class and its name: a rename or a removal is a compile error. */
export const carrier = <Methods extends object>(
  service: Context.Key<unknown, Methods>,
  method: keyof Methods & string
): Carrier => ({ method, port: service.key });

/** A whole port. */
export const wholePort = (service: Context.Key<unknown, object>): Carrier => ({
  method: null,
  port: service.key,
});

/** The one exception to ADR 0014's answer 2: the last-administrator rule (operator decision, 2026-10-28). */
const validityDependsOnTime: Exception = {
  reason: "validity depends on time",
  recovery:
    "the Emergency principal of ADR 0011 (Emergency access) restores admin access out of band",
};

export const StoreGuarantees: readonly Guarantee[] = [
  {
    capability: "Transactions",
    carriers: [carrier(Transactor, "run")],
    id: "TX1",
    invariant: false,
    property:
      "All writes made in one transaction become visible to other transactions together, or none do. A typed failure, a defect or an interruption of the program leaves none. `run` succeeding means committed.",
    rawWriter:
      "writes outside a transaction while one is open: the other transaction's writes still appear together or not at all",
    strength: "store-enforced",
  },
  {
    capability: "Transactions",
    carriers: [carrier(Transactor, "run")],
    id: "TX2",
    invariant: false,
    property:
      "A nested scope undoes its own writes when it fails and releases the locks it took; when it succeeds it hands both to the enclosing scope.",
    rawWriter:
      "writes during a nested scope that fails: the enclosing scope's own writes survive",
    strength: "store-enforced",
  },
  {
    capability: "Transactions",
    carriers: [wholePort(InTransaction)],
    id: "TX3",
    invariant: false,
    property:
      "The isolation floor ReadCommittedWithLocks: no read sees another transaction's uncommitted write; a read made after a lock on a record returns the record as of the grant of the lock or later, so a decision read through a token sees the latest committed state. Nothing is promised across two reads of unlocked records: they may differ, so a program that needs one state reads it in one call or locks. A stronger isolation level satisfies it and is allowed.",
    rawWriter:
      "commits a change to a locked record while another transaction waits for the lock: the waiter reads the new state",
    strength: "store-enforced",
  },
  {
    capability: "Transactions",
    carriers: [
      carrier(Transactor, "run"),
      carrier(AggregateLocks, "lock"),
      carrier(AggregateLocks, "lockAll"),
    ],
    id: "TX4",
    invariant: false,
    property:
      "A deadlock or a serialization failure is a defect and is never retried; the lock order (LK2) is what keeps it from arising.",
    rawWriter:
      "locks the same records in the opposite order by hand: it deadlocks with a port user, which is why the order is a rule of the port",
    strength: "port-enforced",
  },
  {
    capability: "Transactions",
    carriers: [wholePort(InTransaction)],
    id: "TX5",
    invariant: false,
    property:
      "`InTransaction` is provided only by a `Transactor`, or by a test composition that keeps TX1 to TX3; a program that holds it runs inside such a scope.",
    rawWriter:
      "provides the proof around a program that runs outside a transaction: nothing in the store refuses it",
    strength: "port-enforced",
  },
  {
    capability: "AggregateLocks",
    carriers: [
      carrier(AggregateLocks, "lock"),
      carrier(AggregateLocks, "lockAll"),
    ],
    id: "LK1",
    invariant: false,
    property:
      "At most one transaction holds the lock of a root's record at a time; a second request for it waits until the first ends.",
    rawWriter:
      "writes the record without asking for its lock: the write goes through while another transaction holds it",
    strength: "port-enforced",
  },
  {
    capability: "AggregateLocks",
    carriers: [
      carrier(AggregateLocks, "lock"),
      carrier(AggregateLocks, "lockAll"),
    ],
    id: "LK2",
    invariant: false,
    property:
      "Locks are taken in one order: the roots in `AggregateRoots` order, the records of a root in ascending id. A request that would break the order is a defect found at its first run, so lockers cannot wait on each other in a cycle.",
    rawWriter:
      "takes two locks in descending order: it deadlocks with a port user in each round",
    strength: "port-enforced",
  },
  {
    capability: "AggregateLocks",
    carriers: [
      carrier(AggregateLocks, "lock"),
      carrier(AggregateLocks, "lockAll"),
    ],
    id: "LK3",
    invariant: false,
    property:
      "A token is good only in the transaction that holds the lock of its record, for its root; any other use is a defect and never reads or writes. Locking a record already held returns the same token and takes nothing.",
    rawWriter:
      "makes a token by hand or keeps one from a finished transaction: the port refuses it, the store would not",
    strength: "port-enforced",
  },
  {
    capability: "AggregateLocks",
    carriers: [
      carrier(AggregateLocks, "lock"),
      carrier(AggregateLocks, "lockAll"),
    ],
    id: "LK4",
    invariant: false,
    property:
      "A record that has been merged away cannot be locked (`NotFound`), and a lock that waited for the merge observes it.",
    rawWriter:
      "writes through a lock request that bypasses the port's check for merged records",
    strength: "port-enforced",
  },
  {
    capability: "AggregateLocks",
    carriers: [
      carrier(MembershipRepository, "insert"),
      carrier(MembershipRepository, "setEnd"),
      carrier(MembershipRepository, "remove"),
      carrier(AdminGrantRepository, "create"),
      carrier(AccountRepository, "transition"),
      carrier(CodeRepository, "replace"),
      carrier(ConsentRepository, "record"),
    ],
    id: "LK5",
    invariant: false,
    property:
      "A record that a root owns is written only through the root's token; a stored machine's state changes only through the machine's transitions.",
    rawWriter:
      "writes an owned record or a machine's state directly: it succeeds, and only the types and the lint rule refuse it",
    strength: "port-enforced",
  },
  {
    capability: "AggregateLocks",
    carriers: [carrier(AggregateLocks, "lock")],
    id: "LK6",
    invariant: true,
    property: "Exactly one admin-list record exists.",
    rawWriter: "inserts a second admin-list record or deletes the one: refused",
    strength: "store-enforced",
  },
  {
    capability: "AggregateLocks",
    carriers: [
      carrier(AccountRepository, "isLastActiveAdmin"),
      carrier(AdminGrantRepository, "revoke"),
      carrier(AdminGrantRepository, "create"),
    ],
    exception: validityDependsOnTime,
    id: "LK7",
    invariant: true,
    property:
      "At least one Active administrator with a valid place remains after every deactivation, reactivation, grant and revocation: decided under the admin list's lock, on every administrator at once. No importer and no migration removes the last Active administrator.",
    rawWriter:
      "deactivates the last Active administrator's account directly: it succeeds (a place also lapses with time, so no stored-row predicate can hold it)",
    strength: "port-enforced",
  },
  {
    capability: "UniqueKeys",
    carriers: [
      carrier(DepartmentRepository, "create"),
      carrier(DepartmentRepository, "update"),
      carrier(TeamRepository, "create"),
      carrier(TeamRepository, "update"),
      carrier(PersonRepository, "create"),
      carrier(AccountRepository, "updateProfile"),
      carrier(SemesterRepository, "ensure"),
      carrier(PublicFileRepository, "register"),
      carrier(WorkspaceAssignments, "assign"),
      carrier(CodeRepository, "replace"),
      carrier(CapturedMessageStore, "record"),
    ],
    id: "UK1",
    invariant: true,
    property:
      "At most one record per natural key: department city; person e-mail and company e-mail; team name within its department and team group e-mail; semester (term, year); public file key and legacy path; position name; one-time code hash; company address; captured delivery key.",
    rawWriter: "inserts a second record with the same key: refused",
    strength: "store-enforced",
  },
  {
    capability: "UniqueKeys",
    carriers: [
      carrier(DepartmentRepository, "create"),
      carrier(TeamRepository, "create"),
      carrier(PersonRepository, "create"),
      carrier(WorkspaceAssignments, "assign"),
    ],
    id: "UK2",
    invariant: false,
    property:
      "A write refused for a duplicate key fails with `AlreadyExists` carrying the entity and the key, never as a defect.",
    rawWriter:
      "gets the store's own refusal, with no entity and no key: the port is what names them",
    strength: "port-enforced",
  },
  {
    capability: "UniqueKeys",
    carriers: [
      carrier(SemesterRepository, "ensure"),
      carrier(PublicFileRepository, "register"),
    ],
    id: "UK3",
    invariant: false,
    property:
      "Find-or-create: concurrent callers all receive the one record; a repeat changes nothing.",
    rawWriter:
      "inserts the record first: the caller receives that record and no second one exists",
    strength: "store-enforced",
  },
  {
    capability: "NonOverlap",
    carriers: [
      carrier(MembershipRepository, "insert"),
      carrier(MembershipRepository, "setEnd"),
    ],
    id: "NO1",
    invariant: true,
    property:
      "One person's memberships in one team never overlap (closed ranges of semester ordinals; a term that starts the semester after another ends does not overlap it).",
    rawWriter: "inserts an overlapping membership: refused",
    strength: "store-enforced",
  },
  {
    capability: "NonOverlap",
    carriers: [
      carrier(MembershipRepository, "insert"),
      carrier(MembershipRepository, "setEnd"),
    ],
    id: "NO2",
    invariant: true,
    property:
      "A membership's start is not after its end; the ordinals follow the term.",
    rawWriter: "inserts a membership that ends before it starts: refused",
    strength: "store-enforced",
  },
  {
    capability: "NonOverlap",
    carriers: [
      carrier(MembershipRepository, "insert"),
      carrier(MembershipRepository, "setEnd"),
    ],
    id: "NO3",
    invariant: false,
    property:
      "Of two concurrent writes that overlap, exactly one commits and the other fails with `AlreadyExists`, never with a deadlock.",
    rawWriter:
      "writes an overlapping term without the person's lock: it can meet the other write in a deadlock",
    strength: "port-enforced",
  },
  {
    capability: "ConditionalWrites",
    carriers: [
      carrier(AccountRepository, "transition"),
      carrier(MembershipRepository, "setEnd"),
      carrier(MembershipRepository, "remove"),
    ],
    id: "CW1",
    invariant: false,
    property:
      "A write that depends on a record's state is judged against its newest committed state when it takes effect: if the expected state no longer holds, nothing is written and the caller gets `Conflict`. Of two concurrent transitions from one state, exactly one wins.",
    rawWriter:
      "writes the state unconditionally: both transitions win, in every round",
    strength: "port-enforced",
  },
  {
    capability: "ConditionalWrites",
    carriers: [
      carrier(CodeRepository, "replace"),
      carrier(ConsentRepository, "record"),
    ],
    id: "CW2",
    invariant: false,
    property:
      "A replace never rewrites another owner's record, and replaces the owner's own.",
    rawWriter:
      "replaces by a key that leaves the owner out: it rewrites another owner's record",
    strength: "port-enforced",
  },
  {
    capability: "ConditionalWrites",
    carriers: [carrier(RetentionRun, "run")],
    id: "RT1",
    invariant: false,
    property:
      "A retention run at one instant is idempotent: a second run at the same instant changes nothing. A record expires when its period, counted in Oslo calendar time from its trigger, has passed `now`. The mode (`Apply` or `ReportOnly`) is fixed by the layer: a program cannot choose it.",
    rawWriter:
      "edits a record that a run keeps, between two runs: the second run applies the same rule to it",
    strength: "port-enforced",
  },
  {
    capability: "ConditionalWrites",
    carriers: [
      carrier(PersonalDataStore, "erase"),
      carrier(PersonalDataStore, "merge"),
      carrier(LegalHolds, "of"),
    ],
    id: "ER1",
    invariant: false,
    property:
      "An erasure of one person applies each table's declared expiry and keeps the rows of a table that is `Kept`; a second call changes nothing. A merge moves every row of one person to another by the catalog's rules and makes the first a tombstone, or fails with `Conflict` and changes nothing.",
    rawWriter:
      "writes a row about the erased person after the erasure: the row stays, nothing erases it again until a rule says so",
    strength: "port-enforced",
  },
  {
    capability: "Claims",
    carriers: [
      carrier(WelcomeLedger, "claim"),
      carrier(DigestLedger, "claim"),
      carrier(AlumniRequests, "claim"),
      carrier(JobRuns, "claim"),
      carrier(WorkspaceAssignments, "assign"),
      carrier(CapturedMessageStore, "record"),
    ],
    id: "CL1",
    invariant: true,
    property:
      "At most one claim per key: the first-membership welcome per person; the ending-soon digest per person and semester; the alumni request per person and engagement end; a job's run per job and period; a company address; a captured message per delivery key.",
    rawWriter: "inserts a second claim with the same key: refused",
    strength: "store-enforced",
  },
  {
    capability: "Claims",
    carriers: [
      carrier(WelcomeLedger, "claim"),
      carrier(DigestLedger, "claim"),
      carrier(AlumniRequests, "claim"),
      carrier(JobRuns, "claim"),
    ],
    id: "CL2",
    invariant: false,
    property:
      "Of concurrent callers of one key, exactly one is told it made the claim; the others are told it was taken.",
    rawWriter:
      "inserts the claim first: every port caller is told it was taken",
    strength: "port-enforced",
  },
  {
    capability: "Claims",
    carriers: [
      carrier(WelcomeLedger, "claim"),
      carrier(DigestLedger, "claim"),
      carrier(AlumniRequests, "claim"),
      carrier(Outbox, "enqueue"),
      carrier(AuditLog, "record"),
    ],
    id: "CL3",
    invariant: false,
    property:
      "A claim commits with the writes it guards: the claim, the message queued for it and its audit row become visible together or not at all. A claim that commits alone is a message never sent.",
    rawWriter:
      "commits a claim without its message: the key is taken and the message is never sent, so the port methods require the transaction",
    strength: "port-enforced",
    transactional: [
      carrier(WelcomeLedger, "claim"),
      carrier(DigestLedger, "claim"),
      carrier(AlumniRequests, "claim"),
      carrier(Outbox, "enqueue"),
      carrier(AuditLog, "record"),
    ],
  },
  {
    capability: "WorkQueue",
    carriers: [carrier(OutboxDelivery, "claim")],
    id: "LS1",
    invariant: false,
    property:
      "A pending outbox record has at most one live claim; of any number of claimers, exactly one holds it. A duplicate message finds it `Held` or `Settled` and never sends twice.",
    rawWriter:
      "claims a record that another claim holds: it takes the record, and both senders send",
    strength: "port-enforced",
  },
  {
    capability: "WorkQueue",
    carriers: [
      carrier(OutboxDelivery, "markDelivered"),
      carrier(OutboxDelivery, "markFailed"),
    ],
    id: "LS2",
    invariant: false,
    property:
      "An acknowledgement or release that carries a claim token other than the record's current one changes nothing and reports `claimLost`.",
    rawWriter:
      "overwrites the claim token: a stale claimant's acknowledgement then succeeds",
    strength: "port-enforced",
  },
  {
    capability: "WorkQueue",
    carriers: [wholePort(OutboxDelivery)],
    id: "LS3",
    invariant: false,
    property:
      "Delivery is at least once, with no order across records; a provider can hear of a record twice when its send succeeded and the acknowledgement did not commit.",
    rawWriter: "no writer can make this false: it is a promise to callers",
    strength: "port-enforced",
  },
  {
    capability: "WorkQueue",
    carriers: [carrier(OutboxDelivery, "markDelivered")],
    id: "LS4",
    invariant: false,
    property:
      "`markDelivered` is one conditional write that joins the caller's transaction when there is one (the acknowledgement then commits or rolls back with the caller's writes) and commits alone otherwise. Which of the two holds is the caller's, and the port neither requires nor reports it.",
    rawWriter:
      "acknowledges outside the caller's transaction: the acknowledgement survives the caller's rollback",
    strength: "port-enforced",
  },
  {
    capability: "WorkQueue",
    carriers: [
      carrier(OutboxDelivery, "markQueued"),
      carrier(OutboxDelivery, "stale"),
      carrier(OutboxDelivery, "markDead"),
      carrier(OutboxDelivery, "recordFailure"),
    ],
    id: "LS5",
    invariant: false,
    property:
      "The queue's receipt (`markQueued`) is recorded only for pending records; `stale` lists pending records with no live claim whose last receipt or next attempt is not after the cut-off; a dead ending is recorded only after a failure class was recorded.",
    rawWriter:
      "ends a record that has no recorded failure: it ends, and the sweep no longer finds it",
    strength: "port-enforced",
  },
  {
    capability: "Leases",
    carriers: [
      carrier(JobRuns, "claim"),
      carrier(JobRuns, "advance"),
      carrier(JobRuns, "finish"),
      carrier(JobRuns, "release"),
      carrier(JobRuns, "fail"),
    ],
    id: "LS6",
    invariant: false,
    property:
      "A job's period has one runner: a claim never waits; a runner whose period was taken over writes nothing (`LeaseLost`); a chunk's rows and its cursor commit together.",
    rawWriter:
      "writes a period's cursor without its attempt: a taken-over runner then adds to the run",
    strength: "port-enforced",
    transactional: [carrier(JobRuns, "advance"), carrier(JobRuns, "finish")],
  },
  {
    capability: "Snapshots",
    carriers: [carrier(PersonalDataStore, "exportOf")],
    id: "SN1",
    invariant: false,
    property:
      "The export of one person reflects one committed state: no transaction's effects appear in part. It writes nothing and takes no lock. The method makes the snapshot itself, because its caller's transaction gives none (TX3).",
    rawWriter:
      "commits a multi-table change while an export runs: the export shows all of it or none",
    strength: "store-enforced",
  },
  {
    capability: "Snapshots",
    carriers: [
      carrier(PrincipalDirectory, "activeById"),
      carrier(PrincipalDirectory, "byName"),
    ],
    id: "SN2",
    invariant: false,
    property:
      "A person's principal (account state, memberships active in a given semester, the end of every admin place) is as of one committed state at the instant of the read, and is not refreshed during the request. A decision that must hold against later change does not rest on it: it is decided again under a lock (LK1, CW1, LK7).",
    rawWriter:
      "deactivates the account and ends a place in one commit while the read runs: the principal shows both or neither",
    strength: "store-enforced",
  },
  {
    capability: "ReadOnlyReads",
    carriers: [
      carrier(AuditLog, "latest"),
      carrier(OutboxReports, "overview"),
      carrier(PrincipalDirectory, "names"),
      carrier(WorkspaceReports, "latest"),
    ],
    id: "RR1",
    invariant: false,
    property:
      "A read (every method of mode `Read`) writes nothing and takes no lock.",
    rawWriter:
      "no writer can make this false; a role that holds read access only shows that the port never writes",
    strength: "port-enforced",
  },
  {
    capability: "ObjectStore",
    carriers: [carrier(FileStore, "put")],
    id: "OS1",
    invariant: false,
    property:
      "`put` of one content-addressed key is idempotent: a repeat leaves the same object.",
    rawWriter:
      "puts different bytes under the same key: the object store keeps them, and only the key's derivation prevents it",
    strength: "port-enforced",
  },
];

/** What the domain does not promise (spec 0018, SN3): a state that no single instant held may be shown. */
export const NonGuarantees: readonly NonGuarantee[] = [
  {
    carriers: [
      carrier(OutboxReports, "overview"),
      carrier(WorkspaceFacts, "people"),
      carrier(WorkspaceFacts, "storedAddresses"),
      carrier(WorkspaceReports, "read"),
      carrier(WorkspaceReports, "latest"),
    ],
    id: "SN3",
    statement:
      "No snapshot is promised across separate reads: `OutboxReports.overview`, `WorkspaceFacts` and `WorkspaceReports.read`/`.latest` may each show a state that no single instant held.",
  },
];

/** A declaration of every port method's transaction mode, by the class name of the port (`TransactionModes`). */
type ModesByPort = Readonly<
  Record<string, Readonly<Record<string, TransactionMode>>>
>;

/** The mode that a declaration gives a carrier's method, or `undefined` when it gives none. */
const modeOf = (
  modes: ModesByPort,
  carried: Carrier
): TransactionMode | undefined =>
  carried.method === null
    ? undefined
    : modes[portNameOf(carried.port)]?.[carried.method];

const sameCarrier = (left: Carrier, right: Carrier): boolean =>
  left.port === right.port && left.method === right.method;

/** What is wrong with the carriers that a guarantee says need a transaction. */
const transactionProblems = (
  guarantee: Guarantee,
  modes: ModesByPort
): readonly string[] =>
  Arr.flatMap(guarantee.transactional ?? [], (claimed) => {
    const label = `${portNameOf(claimed.port)}.${claimed.method ?? "*"}`;
    const mode = modeOf(modes, claimed);

    if (!Arr.some(guarantee.carriers, (other) => sameCarrier(other, claimed))) {
      return [
        `${guarantee.id} says ${label} needs a transaction but does not carry it`,
      ];
    }

    return mode === "Requires"
      ? []
      : [
          `${guarantee.id} says ${label} needs a transaction, and TransactionModes says ${mode ?? "nothing"} (it must be Requires)`,
        ];
  });

/**
 * What is wrong with a declaration, as sentences; empty when it holds together. A plain function: the real declaration
 * and the fixtures of the test that shows each problem are both passed to it. `modes` is `TransactionModes` for the real
 * declaration; a fixture passes its own.
 */
export const problemsOf = (
  guarantees: readonly Guarantee[],
  modes: ModesByPort = TransactionModes
): readonly string[] => {
  const ids = Arr.map(guarantees, ({ id }) => id);

  const twice = Arr.filter(
    Arr.dedupe(ids),
    (id) => Arr.filter(ids, (other) => other === id).length > 1
  );

  return [
    ...Arr.map(twice, (id) => `${id} is declared twice`),
    ...Arr.flatMap(guarantees, (guarantee) => {
      const problems: string[] = [...transactionProblems(guarantee, modes)];

      if (
        guarantee.invariant &&
        guarantee.strength === "port-enforced" &&
        guarantee.exception === undefined
      ) {
        problems.push(
          `${guarantee.id} is an invariant and port-enforced, with no named exception (ADR 0014, answer 2)`
        );
      }

      if (
        guarantee.exception !== undefined &&
        !(guarantee.invariant && guarantee.strength === "port-enforced")
      ) {
        problems.push(
          `${guarantee.id} names an exception but is not a port-enforced invariant`
        );
      }

      if (guarantee.rawWriter.trim() === "") {
        problems.push(`${guarantee.id} has no raw-writer case`);
      }

      return problems;
    }),
  ];
};
