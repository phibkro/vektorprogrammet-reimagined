/**
 * Runs a program as an actor over the in-memory services (`memory.ts`), the way a server function does, and
 * answers with the runtime's serializable `Outcome` (the error table's statuses included).
 */
import type {
  Actor,
  ArticleRepository,
  AuditLog,
  CurrentActor,
  DepartmentRepository,
  FieldOfStudyRepository,
  InTransaction,
  PublicFileRepository,
  SemesterRepository,
  SocialEventRepository,
  SponsorRepository,
  StaticContentRepository,
} from "@vektorprogrammet/domain";
import { Effect } from "effect";

import type { RequestError } from "../../src/server/errors";
import { runCommandOutcome, runOutcome } from "../../src/server/runtime";
import { memoryLayer } from "./memory";
import type { MemoryTables } from "./memory";

const { signal } = new AbortController();

type ViewServices =
  | CurrentActor
  | ArticleRepository
  | DepartmentRepository
  | SemesterRepository
  | FieldOfStudyRepository
  | PublicFileRepository
  | SocialEventRepository
  | SponsorRepository
  | StaticContentRepository
  | AuditLog;

/** Runs a command as `actor` exactly as a server function does: in a transaction, through the error table. */
export const runAs = <
  A,
  E extends RequestError,
  R extends ViewServices | InTransaction,
>(
  tables: MemoryTables,
  actor: Actor,
  command: Effect.Effect<A, E, R>
) =>
  Effect.promise(
    async () =>
      await runCommandOutcome(
        memoryLayer(tables, actor),
        Effect.void,
        () => command,
        signal
      )
  );

/** Runs a view (a loader's program) as `actor` through the error table. */
export const viewAs = <A, E extends RequestError, R extends ViewServices>(
  tables: MemoryTables,
  actor: Actor,
  view: Effect.Effect<A, E, R>
) =>
  Effect.promise(
    async () => await runOutcome(memoryLayer(tables, actor), view, signal)
  );
