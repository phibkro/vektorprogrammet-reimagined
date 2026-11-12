import type { CodeRepository } from "../../features/accounts/domain/codeRepository.ts";
import type { AccountRepository } from "../../features/accounts/domain/services.ts";
import type { SignInDirectory } from "../../features/accounts/domain/signInDirectory.ts";
import type { ApplicationRepository } from "../../features/admission/domain/services.ts";
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
 * - `Outside`: provider I/O. It must never run inside a transaction. The ports of other systems (`WorkspaceDirectory`,
 *   `WorkspaceWriter`) are marked `IntegrationPort`, and `Transactor.run` refuses a program that requires one (ADR 0015,
 *   spec 0020); the R2 `FileStore` is the platform and stays a convention that the type system does not check.
 * - `Opens`: opens its own transaction and takes none (`Transactor.run`, `ImportTarget.replaceAll`, and
 *   `IsolationProbe.report` and `PlatformProbe.report`, which open the transactions they report on).
 *
 * The declaration is exhaustive by its type: a method of a port without a row, and a row without a method, do not
 * compile. `test/shared/transactionModes.test.ts` checks every row against the method's type, and
 * `tools/quality/test/storePorts.test.ts` finds every service of this package in this table or in `NotStorePorts`.
 */
import type { AuditLog } from "../../features/audit/domain/auditLog.ts";
import type {
  Collection,
  ContentEditor,
} from "../../features/cms/domain/client.ts";
import type { SocialEventRepository } from "../../features/events/domain/services.ts";
import type {
  FileStore,
  PublicFileRepository,
} from "../../features/files/domain/services.ts";
import type { ImpactSnapshots } from "../../features/impact/domain/services.ts";
import type { ImpactSource } from "../../features/impact/domain/source.ts";
import type { ImportTarget } from "../../features/organisation/domain/legacyImport.ts";
import type {
  AdmissionPeriodRepository,
  DepartmentRepository,
  FieldOfStudyRepository,
  SemesterRepository,
} from "../../features/organisation/domain/services.ts";
import type {
  AlumniRequests,
  ConsentRepository,
  LegalHolds,
  PersonalDataStore,
  RetentionRun,
} from "../../features/personal-data/domain/services.ts";
import type {
  AdminGrantRepository,
  DigestLedger,
  MembershipRepository,
  PersonRepository,
  PositionRepository,
  PrincipalDirectory,
  TeamRepository,
  WelcomeLedger,
} from "../../features/teams/domain/services.ts";
import type {
  WorkspaceAssignments,
  WorkspaceDirectory,
  WorkspaceFacts,
  WorkspaceReports,
  WorkspaceWriter,
} from "../../features/workspace/domain/services.ts";
import type { JobRuns } from "../jobs/runs.ts";
import type { CapturedMessageStore } from "../outbox/captured.ts";
import type { OutboxDelivery } from "../outbox/delivery.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { OutboxReports } from "../outbox/status.ts";
import type { AggregateLocks } from "../transactions/aggregate.ts";
import type { Transactor } from "../transactions/transactor.ts";
import type { IsolationProbe } from "./isolationProbe.ts";
import type { PlatformProbe } from "./platformProbe.ts";

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
  readonly ApplicationRepository: ApplicationRepository;
  readonly AggregateLocks: AggregateLocks;
  readonly AlumniRequests: AlumniRequests;
  readonly AuditLog: AuditLog;
  readonly CapturedMessageStore: CapturedMessageStore;
  readonly CodeRepository: CodeRepository;
  readonly ContentEditor: ContentEditor;
  readonly ConsentRepository: ConsentRepository;
  readonly DepartmentRepository: DepartmentRepository;
  readonly DigestLedger: DigestLedger;
  readonly FieldOfStudyRepository: FieldOfStudyRepository;
  readonly FileStore: FileStore;
  readonly ImpactSnapshots: ImpactSnapshots;
  readonly ImpactSource: ImpactSource;
  readonly ImportTarget: ImportTarget;
  readonly IsolationProbe: IsolationProbe;
  readonly JobRuns: JobRuns;
  readonly LegalHolds: LegalHolds;
  readonly MembershipRepository: MembershipRepository;
  readonly Outbox: Outbox;
  readonly OutboxDelivery: OutboxDelivery;
  readonly OutboxReports: OutboxReports;
  readonly PersonRepository: PersonRepository;
  readonly PersonalDataStore: PersonalDataStore;
  readonly PlatformProbe: PlatformProbe;
  readonly PositionRepository: PositionRepository;
  readonly PrincipalDirectory: PrincipalDirectory;
  readonly PublicFileRepository: PublicFileRepository;
  readonly RetentionRun: RetentionRun;
  readonly SemesterRepository: SemesterRepository;
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

/** All CMS collections expose these same operations through the CmsClient namespace. */
export const CmsCollectionModes = {
  create: "Joins",
  listings: "Read",
  publish: "Joins",
  published: "Read",
  publishedBySlug: "Read",
} as const satisfies ModesOf<{
  readonly CmsCollection: { readonly Service: Collection<unknown> };
}>["CmsCollection"];

export const TransactionModes = {
  AccountRepository: {
    emailOf: "Requires",
    find: "Read",
    findAuthIdentitiesByPersonId: "Read",
    findAuthIdentity: "Read",
    findLocked: "Requires",
    invite: "Requires",
    isLastActiveAdmin: "Requires",
    list: "Read",
    transition: "Requires",
    updateProfile: "Requires",
    verifiedHolderOf: "Read",
    verifyEmail: "Requires",
  },
  AdminGrantRepository: {
    create: "Requires",
    findById: "Read",
    list: "Read",
    revoke: "Requires",
  },
  AdmissionPeriodRepository: {
    create: "Standalone",
    extend: "Standalone",
    findById: "Read",
    list: "Read",
    listStored: "Read",
    remove: "Standalone",
  },
  AggregateLocks: { lock: "Requires", lockAll: "Requires" },
  AlumniRequests: { candidates: "Read", claim: "Requires" },
  ApplicationRepository: {
    existsForAddress: "Read",
    find: "Read",
    findLocked: "Requires",
    insert: "Requires",
    list: "Read",
    transition: "Requires",
  },
  AuditLog: { latest: "Read", record: "Requires" },
  CapturedMessageStore: { record: "Standalone" },
  CodeRepository: {
    acknowledge: "Requires",
    consume: "Requires",
    findUsable: "Read",
    issue: "Requires",
  },
  ConsentRepository: { of: "Read", ofLocked: "Requires", record: "Requires" },
  ContentEditor: {
    create: "Joins",
    list: "Read",
    publish: "Joins",
    save: "Joins",
  },
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
  ImpactSnapshots: { close: "Standalone", read: "Read" },
  ImpactSource: { answers: "Read", schools: "Read" },
  ImportTarget: { replaceAll: "Opens" },
  IsolationProbe: { report: "Opens" },
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
    due: "Read",
    holdClaim: "Requires",
    markDelivered: "Joins",
    markFailed: "Standalone",
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
  PlatformProbe: { report: "Opens" },
  PositionRepository: { findById: "Read", list: "Read" },
  PrincipalDirectory: { activeById: "Read", byName: "Read", names: "Read" },
  PublicFileRepository: {
    findByKey: "Read",
    findByLegacyPath: "Read",
    register: "Standalone",
  },
  RetentionRun: { run: "Requires" },
  SemesterRepository: { ensure: "Standalone", find: "Read", list: "Read" },
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
    holdPresence: "Requires",
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

/** Services without direct store operations: each entry explains its role. */
export const NotStorePorts = {
  CmsClient:
    "namespace of collections; their store operations are declared in CmsCollectionModes",
  CurrentPrincipal: "who acts: a value of the request, not a store capability",
  InTransaction: "the proof that `Transactor.run` provides (TX1 to TX5)",
  Info: "the declaration of the command that runs: a value of the request",
  SiteOrigin: "the address of the site: configuration, not a store capability",
} as const;
