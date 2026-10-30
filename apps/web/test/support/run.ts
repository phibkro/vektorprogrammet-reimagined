/**
 * Runs a program as a principal over the in-memory services (`memory.ts`), the way a server function does, and
 * answers with the runtime's serializable `Outcome` (the error table's statuses included).
 */
import type {
  AccountRepository,
  AdmissionPeriodRepository,
  AdminGrantRepository,
  AggregateLocks,
  ApplicationRepository,
  AuditLog,
  CurrentPrincipal,
  DepartmentRepository,
  DigestLedger,
  FieldOfStudyRepository,
  ImpactSnapshots,
  ImpactSource,
  InTransaction,
  MembershipRepository,
  Outbox,
  PersonRepository,
  PositionRepository,
  Principal,
  PrincipalDirectory,
  PublicFileRepository,
  SemesterRepository,
  SiteOrigin,
  SocialEventRepository,
  TeamRepository,
  WelcomeLedger,
  OutboxReports,
  WorkspaceReports,
} from "@vektorprogrammet/domain";
import { Effect } from "effect";

import type { RequestError } from "../../src/server/errors";
import { runCommandOutcome, runOutcome } from "../../src/server/runtime";
import { memoryLayer } from "./memory";
import type { MemoryTables } from "./memory";

const { signal } = new AbortController();

export type ViewServices =
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
