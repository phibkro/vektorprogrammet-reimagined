import { Effect } from "effect";

import type {
  CurrentPrincipal,
  Principal,
} from "../../src/core/kernel/principal";
import type { Outbox } from "../../src/core/outbox/outbox";
import type { OutboxReports } from "../../src/core/outbox/status";
import type { SiteOrigin } from "../../src/core/siteOrigin";
import type { AggregateLocks } from "../../src/core/transactions/aggregate";
import type { InTransaction } from "../../src/core/transactions/transaction";
import type { AccountRepository } from "../../src/features/accounts/domain/services";
import type { ApplicationRepository } from "../../src/features/admission/domain/services";
import type { AuditLog } from "../../src/features/audit/domain/auditLog";
/**
 * Runs a program as a principal over the in-memory services (`memory.ts`), the way a server function does, and
 * answers with the runtime's serializable `Outcome` (the error table's statuses included).
 */
import type { ContentEditor } from "../../src/features/cms/domain/client";
import type { SocialEventRepository } from "../../src/features/events/domain/services";
import type { PublicFileRepository } from "../../src/features/files/domain/services";
import type { ImpactSnapshots } from "../../src/features/impact/domain/services";
import type { ImpactSource } from "../../src/features/impact/domain/source";
import type {
  AdmissionPeriodRepository,
  DepartmentRepository,
  FieldOfStudyRepository,
  SemesterRepository,
} from "../../src/features/organisation/domain/services";
import type {
  AdminGrantRepository,
  DigestLedger,
  MembershipRepository,
  PersonRepository,
  PositionRepository,
  PrincipalDirectory,
  TeamRepository,
  WelcomeLedger,
} from "../../src/features/teams/domain/services";
import type { WorkspaceReports } from "../../src/features/workspace/domain/services";
import type { RequestError } from "../../src/http/requestError";
import { runCommandOutcome, runOutcome } from "../../src/server/runtime";
import { memoryLayer } from "./memory";
import type { MemoryTables } from "./memory";

const { signal } = new AbortController();

export type ViewServices =
  | ContentEditor
  | AccountRepository
  | AdmissionPeriodRepository
  | AggregateLocks
  | ApplicationRepository
  | CurrentPrincipal
  | SiteOrigin
  | DepartmentRepository
  | SemesterRepository
  | FieldOfStudyRepository
  | PublicFileRepository
  | SocialEventRepository
  | PersonRepository
  | TeamRepository
  | PositionRepository
  | MembershipRepository
  | AdminGrantRepository
  | PrincipalDirectory
  | DigestLedger
  | Outbox
  | AuditLog
  | WelcomeLedger
  | OutboxReports
  | WorkspaceReports
  | ImpactSnapshots
  | ImpactSource;

/** Runs a command as `principal` exactly as a server function does: in a transaction, through the error table. */
export const runAs = <
  A,
  E extends RequestError,
  R extends ViewServices | InTransaction,
>(
  tables: MemoryTables,
  principal: Principal,
  command: Effect.Effect<A, E, R>
) =>
  Effect.promise(
    async () =>
      await runCommandOutcome(
        memoryLayer(tables, principal),
        Effect.void,
        () => command,
        signal
      )
  );

/** Runs a view (a loader's program) as `principal` through the error table. */
export const viewAs = <A, E extends RequestError, R extends ViewServices>(
  tables: MemoryTables,
  principal: Principal,
  view: Effect.Effect<A, E, R>
) =>
  Effect.promise(
    async () => await runOutcome(memoryLayer(tables, principal), view, signal)
  );
