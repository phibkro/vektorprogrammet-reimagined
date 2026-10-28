import type { CodeRepository } from "../accounts/codeRepository.ts";
import type { AccountRepository } from "../accounts/services.ts";
import type { SessionDirectory } from "../accounts/sessionDirectory.ts";
import type { SignInDirectory } from "../accounts/signInDirectory.ts";
/**
 * What every store port asks of a transaction, method by method (spec 0018). A method is in exactly one mode:
 *
 * - `Requires`: its guarantee spans writes, or rests on a lock, so it is meaningless outside a transaction. Its type
 *   requires `InTransaction`.
 * - `Standalone`: one atomic step or an idempotent write, complete when it commits alone. A caller may still put it
 *   inside a transaction (a command does, to commit it with its audit row).
 * - `Joins`: one conditional write that commits alone, or with the caller's writes when the caller is in a transaction
 *   (`OutboxDelivery.markDelivered`, LS4). It cannot require what it does not need.
 * - `Read`: writes nothing and takes no lock (RR1).
 * - `Outside`: provider I/O. It must never run inside a transaction: a convention that the type system cannot check.
 * - `Opens`: opens its own transaction and takes none (`Transactor.run`, `ImportTarget.replaceAll`).
 *
 * The declaration is exhaustive by its type: a method of a port without a row, and a row without a method, do not
 * compile. `test/shared/transactionModes.test.ts` checks every row against the method's type, and
 * `tools/quality/test/storePorts.test.ts` finds every service of this package in this table or in `NotStorePorts`.
 */
import type { AuditLog } from "../audit/auditLog.ts";
import type { SocialEventRepository } from "../content/services.ts";
import type { FileStore, PublicFileRepository } from "../files/services.ts";
import type { JobRuns } from "../jobs/runs.ts";
import type { ImportTarget } from "../organisation/legacyImport.ts";
import type {
  AdmissionPeriodRepository,
  DepartmentRepository,
  FieldOfStudyRepository,
  SemesterRepository,
} from "../organisation/services.ts";
import type { CapturedMessageStore } from "../outbox/captured.ts";
import type { OutboxDelivery } from "../outbox/delivery.ts";
import type { OutboxReports } from "../outbox/status.ts";
import type {
  AlumniRequests,
  ConsentRepository,
  LegalHolds,
  PersonalDataStore,
  RetentionRun,
} from "../personalData/services.ts";
import type {
  AdminGrantRepository,
  DigestLedger,
  MembershipRepository,
  PersonRepository,
  PositionRepository,
  PrincipalDirectory,
  TeamRepository,
  WelcomeLedger,
} from "../teams/services.ts";
import type {
  WorkspaceAssignments,
  WorkspaceDirectory,
  WorkspaceFacts,
  WorkspaceReports,
  WorkspaceWriter,
} from "../workspace/services.ts";
import type { AggregateLocks } from "./aggregate.ts";
import type { Outbox } from "./outbox.ts";
import type { Transactor } from "./transactor.ts";

export type TransactionMode =
  | "Requires"
  | "Standalone"
  | "Joins"
  | "Read"
  | "Outside"
  | "Opens";

/** Every store port by its class name. A service that is not a store port is in `NotStorePorts` instead. */
export interface StorePorts {
  readonly AccountRepository: AccountRepository;
  readonly AdminGrantRepository: AdminGrantRepository;
  readonly AdmissionPeriodRepository: AdmissionPeriodRepository;
  readonly AggregateLocks: AggregateLocks;
  readonly AlumniRequests: AlumniRequests;
  readonly AuditLog: AuditLog;
  readonly CapturedMessageStore: CapturedMessageStore;
  readonly CodeRepository: CodeRepository;
  readonly ConsentRepository: ConsentRepository;
  readonly DepartmentRepository: DepartmentRepository;
  readonly DigestLedger: DigestLedger;
  readonly FieldOfStudyRepository: FieldOfStudyRepository;
  readonly FileStore: FileStore;
  readonly ImportTarget: ImportTarget;
  readonly JobRuns: JobRuns;
  readonly LegalHolds: LegalHolds;
  readonly MembershipRepository: MembershipRepository;
  readonly Outbox: Outbox;
  readonly OutboxDelivery: OutboxDelivery;
  readonly OutboxReports: OutboxReports;
  readonly PersonRepository: PersonRepository;
  readonly PersonalDataStore: PersonalDataStore;
  readonly PositionRepository: PositionRepository;
  readonly PrincipalDirectory: PrincipalDirectory;
  readonly PublicFileRepository: PublicFileRepository;
  readonly RetentionRun: RetentionRun;
  readonly SemesterRepository: SemesterRepository;
  readonly SessionDirectory: SessionDirectory;
  readonly SignInDirectory: SignInDirectory;
  readonly SocialEventRepository: SocialEventRepository;
  readonly TeamRepository: TeamRepository;
  readonly Transactor: Transactor;
  readonly WelcomeLedger: WelcomeLedger;
  readonly WorkspaceAssignments: WorkspaceAssignments;
  readonly WorkspaceDirectory: WorkspaceDirectory;
  readonly WorkspaceFacts: WorkspaceFacts;
  readonly WorkspaceReports: WorkspaceReports;
  readonly WorkspaceWriter: WorkspaceWriter;
}

/** A row for every method of every port in `Ports`: a missing or an extra method is a type error. */
export type ModesOf<
  Ports extends Record<keyof Ports, { readonly Service: object }>,
> = {
  readonly [Port in keyof Ports]: {
    readonly [Method in keyof Ports[Port]["Service"]]: TransactionMode;
  };
};

export const TransactionModes = {
  AccountRepository: {
    find: "Read",
    findActiveByPrivateEmail: "Read",
    findLocked: "Requires",
    invite: "Requires",
    isLastActiveAdmin: "Requires",
    list: "Read",
    transition: "Requires",
    updateProfile: "Requires",
    verifyEmail: "Requires",
  },
  AdminGrantRepository: {
    create: "Requires",
    findById: "Read",
    list: "Read",
    revoke: "Requires",
  },
  AdmissionPeriodRepository: { list: "Read" },
  AggregateLocks: { lock: "Requires", lockAll: "Requires" },
  AlumniRequests: { candidates: "Read", claim: "Requires" },
  AuditLog: { latest: "Read", record: "Requires" },
  CapturedMessageStore: { record: "Standalone" },
  CodeRepository: {
    consume: "Requires",
    findUsable: "Read",
    replace: "Requires",
  },
  ConsentRepository: { of: "Read", ofLocked: "Requires", record: "Requires" },
  DepartmentRepository: {
    create: "Standalone",
    findById: "Read",
    list: "Read",
    update: "Standalone",
  },
  DigestLedger: { claim: "Requires" },
  FieldOfStudyRepository: {
    create: "Standalone",
    findById: "Read",
    listByDepartment: "Read",
    rename: "Standalone",
  },
  FileStore: { get: "Outside", put: "Outside" },
  ImportTarget: { replaceAll: "Opens" },
  JobRuns: {
    advance: "Requires",
    claim: "Standalone",
    fail: "Standalone",
    finish: "Requires",
    release: "Standalone",
    request: "Requires",
    resumable: "Read",
  },
  LegalHolds: { of: "Requires" },
  MembershipRepository: {
    activeIn: "Read",
    findById: "Read",
    findLocked: "Requires",
    insert: "Requires",
    listByPerson: "Read",
    listByTeam: "Read",
    listLocked: "Requires",
    remove: "Requires",
    setEnd: "Requires",
  },
  Outbox: { enqueue: "Requires" },
  OutboxDelivery: {
    claim: "Standalone",
    markDead: "Standalone",
    markDelivered: "Joins",
    markFailed: "Standalone",
    markQueued: "Standalone",
    recordFailure: "Standalone",
    stale: "Read",
  },
  OutboxReports: { overview: "Read" },
  PersonRepository: {
    create: "Requires",
    findById: "Read",
    findLocked: "Requires",
    list: "Read",
  },
  PersonalDataStore: {
    erase: "Requires",
    exportOf: "Read",
    merge: "Requires",
    setPhoto: "Requires",
  },
  PositionRepository: { findById: "Read", list: "Read" },
  PrincipalDirectory: { activeById: "Read", byName: "Read", names: "Read" },
  PublicFileRepository: {
    findByKey: "Read",
    findByLegacyPath: "Read",
    register: "Standalone",
  },
  RetentionRun: { run: "Requires" },
  SemesterRepository: { ensure: "Standalone", find: "Read", list: "Read" },
  SessionDirectory: { byPerson: "Read" },
  SignInDirectory: {
    match: "Read",
    personOfUser: "Read",
    profileOf: "Read",
    signInEmailOf: "Read",
  },
  SocialEventRepository: { create: "Standalone", list: "Read" },
  TeamRepository: {
    create: "Requires",
    deactivate: "Standalone",
    findById: "Read",
    list: "Read",
    update: "Requires",
  },
  Transactor: { run: "Opens" },
  WelcomeLedger: { claim: "Requires" },
  WorkspaceAssignments: { assign: "Requires" },
  WorkspaceDirectory: {
    accounts: "Outside",
    groups: "Outside",
    members: "Outside",
  },
  WorkspaceFacts: {
    configuredGroupAddresses: "Read",
    departmentEngagements: "Read",
    departments: "Read",
    people: "Read",
    storedAddresses: "Read",
    teamsAfter: "Read",
  },
  WorkspaceReports: {
    append: "Requires",
    complete: "Requires",
    latest: "Read",
    open: "Requires",
    read: "Read",
  },
  WorkspaceWriter: { apply: "Outside" },
} as const satisfies ModesOf<StorePorts>;

/** The services of this package that are not store ports, each with the reason. */
export const NotStorePorts = {
  CurrentPrincipal: "who acts: a value of the request, not a store capability",
  InTransaction: "the proof that `Transactor.run` provides (TX1 to TX5)",
  Info: "the declaration of the command that runs: a value of the request",
  PasswordHasher: "computes a hash; keeps no state",
  SiteOrigin: "the address of the site: configuration, not a store capability",
} as const;
