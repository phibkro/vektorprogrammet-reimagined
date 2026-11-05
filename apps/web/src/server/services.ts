import type { SqlClient } from "effect/sql";

import type * as JobRun from "../core/jobs/runs";
import type { CapturedMessageStore } from "../core/outbox/captured";
import type { OutboxDelivery } from "../core/outbox/delivery";
import type { Outbox } from "../core/outbox/outbox";
import type { OutboxReports } from "../core/outbox/status";
import type { IsolationProbe } from "../core/store/isolationProbe";
import type { PlatformProbe } from "../core/store/platformProbe";
import type { AggregateLocks } from "../core/transactions/aggregate";
import type { Transactor } from "../core/transactions/transactor";
import type { CodeRepository } from "../features/accounts/domain/codeRepository";
import type { AccountRepository } from "../features/accounts/domain/services";
import type { SignInDirectory } from "../features/accounts/domain/signInDirectory";
import type { ApplicationRepository } from "../features/admission/domain/services";
import type { AuditLog } from "../features/audit/domain/auditLog";
import type { SocialEventRepository } from "../features/events/domain/services";
import type { PublicFileRepository } from "../features/files/domain/services";
import type { ImpactSnapshots } from "../features/impact/domain/services";
import type { ImpactSource } from "../features/impact/domain/source";
import type {
  AdmissionPeriodRepository,
  DepartmentRepository,
  SemesterRepository,
  FieldOfStudyRepository,
} from "../features/organisation/domain/services";
import type {
  ConsentRepository,
  AlumniRequests,
  LegalHolds,
  PersonalDataStore,
  RetentionRun,
} from "../features/personal-data/domain/services";
import type {
  PersonRepository,
  TeamRepository,
  PositionRepository,
  MembershipRepository,
  AdminGrantRepository,
  DigestLedger,
  WelcomeLedger,
  PrincipalDirectory,
} from "../features/teams/domain/services";
import type {
  WorkspaceAssignments,
  WorkspaceFacts,
  WorkspaceReports,
} from "../features/workspace/domain/services";

/** What `DatabaseLive` provides (packages/db contract). */
export type DatabaseServices =
  | AccountRepository
  | AggregateLocks
  | CodeRepository
  | AdmissionPeriodRepository
  | ApplicationRepository
  | DepartmentRepository
  | SemesterRepository
  | ImpactSnapshots
  | ImpactSource
  | IsolationProbe
  | PlatformProbe
  | FieldOfStudyRepository
  | SocialEventRepository
  | PublicFileRepository
  | PersonRepository
  | TeamRepository
  | PositionRepository
  | MembershipRepository
  | AdminGrantRepository
  | DigestLedger
  | WelcomeLedger
  | ConsentRepository
  | AlumniRequests
  | LegalHolds
  | PersonalDataStore
  | RetentionRun
  | PrincipalDirectory
  | Outbox
  | OutboxReports
  | AuditLog
  | CapturedMessageStore
  | JobRun.JobRuns
  | WorkspaceAssignments
  | WorkspaceFacts
  | WorkspaceReports
  | OutboxDelivery
  | Transactor
  | SignInDirectory
  | SqlClient.SqlClient;
