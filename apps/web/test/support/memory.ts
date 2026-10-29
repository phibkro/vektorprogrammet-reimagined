/**
 * In-memory Layers for apps/web tests (Node, `vp test`). Real database
 * behaviour is `packages/db`'s job; these fakes implement the domain's
 * service contracts just far enough for the web runtime, routes and outbox
 * delivery to be exercised. Every value is a fake same-shape value.
 */
import {
  AdmissionPeriodRepository,
  AlreadyExists,
  AuditLog,
  CurrentPrincipal,
  DepartmentId,
  DepartmentRepository,
  EmailAddress,
  FieldOfStudyId,
  FieldOfStudyRepository,
  FileKey,
  FileStore,
  InTransaction,
  NotFound,
  Outbox,
  OutboxClaim,
  OutboxClaimToken,
  OutboxDelivery,
  OutboxMessageId,
  OutboxReports,
  PublicFileRepository,
  SemesterId,
  SemesterRepository,
  SiteOrigin,
  SocialEventId,
  SocialEventRepository,
  Transactor,
  WorkspaceReports,
  anonymous,
  deliveryState,
  isListed,
} from "@vektorprogrammet/domain";
import type {
  AdmissionPeriod,
  AuditEntry,
  ClaimedOutboxMessage,
  Department,
  EntityName,
  FieldOfStudy,
  OutboxMessage,
  Principal,
  PublicFile,
  SocialEvent,
  StoredSemester,
} from "@vektorprogrammet/domain";
import {
  makeTeamTables,
  snapshotTeamTables,
  teamsInMemoryOver,
} from "@vektorprogrammet/domain/testing";
import type { TeamTableRefs } from "@vektorprogrammet/domain/testing";
import {
  Array as Arr,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Record as Rec,
  Stream,
} from "effect";

interface OutboxRow {
  readonly id: OutboxMessageId;
  readonly message: OutboxMessage;
  attempts: number;
  status: "pending" | "delivered" | "dead";
  claimToken: OutboxClaimToken | null;
  nextAttemptAt: DateTime.Utc | null;
  queuedAt?: DateTime.Utc | null;
  lastError: string | null;
}

/** The fake tables; tests seed and inspect them directly. */
export interface MemoryTables {
  departments: Department[];
  admissionPeriods: AdmissionPeriod[];
  publicFiles: PublicFile[];
  objects: Map<string, Uint8Array>;
  outbox: OutboxRow[];
  audit: AuditEntry[];
  semesters: StoredSemester[];
  fieldsOfStudy: FieldOfStudy[];
  socialEvents: SocialEvent[];
  /** The teams repositories' tables: the domain's fakes, shared by every layer built over these tables. */
  teams: TeamTableRefs;
  /** Number of `Transactor.run` calls that committed. */
  commits: number;
  /** The next id every table hands out; it survives layer builds and rollbacks, as a sequence does. */
  nextId: number;
}

export class Memory extends Context.Service<Memory, MemoryTables>()(
  "test/Memory"
) {}

/** Fresh tables; tests keep the reference to inspect what was (not) written. */
export const makeTables = (seed: Partial<MemoryTables> = {}): MemoryTables => ({
  admissionPeriods: [],
  audit: [],
  commits: 0,
  departments: [],
  fieldsOfStudy: [],
  nextId: 1,
  objects: new Map(),
  outbox: [],
  publicFiles: [],
  semesters: [],
  socialEvents: [],
  teams: makeTeamTables(),
  ...seed,
});

const findById =
  <A extends { readonly id: number }>(rows: readonly A[], entity: EntityName) =>
  (id: number) =>
    Effect.suspend(() => {
      const found = Option.getOrUndefined(
        Arr.findFirst(rows, (row) => row.id === id)
      );

      return found === undefined
        ? Effect.fail(new NotFound({ entity, key: String(id) }))
        : Effect.succeed(found);
    });

const repositories = Layer.effectContext(
  Effect.gen(function* repositories() {
    const db = yield* Memory;

    const takeId = () => {
      const id = db.nextId;
      db.nextId += 1;

      return id;
    };

    const departments = DepartmentRepository.of({
      create: (draft) =>
        Effect.suspend(() => {
          if (Arr.some(db.departments, (row) => row.city === draft.city)) {
            return Effect.fail(
              new AlreadyExists({
                entity: "Department",
                key: draft.city,
                message: "Byen finnes allerede.",
              })
            );
          }

          const created: Department = {
            id: DepartmentId.make(takeId()),
            ...draft,
          };

          db.departments.push(created);

          return Effect.succeed(created);
        }),
      findById: findById(db.departments, "Department"),
      list: Effect.sync(() => db.departments),
      update: (id, draft) =>
        Effect.suspend(() => {
          const index = Option.getOrElse(
            Arr.findFirstIndex(db.departments, (row) => row.id === id),
            () => -1
          );

          if (index === -1) {
            return Effect.fail(
              new NotFound({ entity: "Department", key: String(id) })
            );
          }

          const updated: Department = { id, ...draft };
          db.departments[index] = updated;

          return Effect.succeed(updated);
        }),
    });

    const semesters = SemesterRepository.of({
      ensure: (semester) =>
        Effect.sync(() => {
          const existing = Option.getOrUndefined(
            Arr.findFirst(
              db.semesters,
              (row) => row.term === semester.term && row.year === semester.year
            )
          );

          if (existing !== undefined) {
            return existing;
          }

          const created: StoredSemester = {
            id: SemesterId.make(takeId()),
            ...semester,
          };

          db.semesters.push(created);

          return created;
        }),
      find: (semester) =>
        Effect.sync(() =>
          Arr.findFirst(
            db.semesters,
            (row) => row.term === semester.term && row.year === semester.year
          )
        ),
      list: Effect.sync(() => db.semesters),
    });

    const fieldsOfStudy = FieldOfStudyRepository.of({
      create: (draft) =>
        Effect.sync(() => {
          const created: FieldOfStudy = {
            id: FieldOfStudyId.make(takeId()),
            ...draft,
          };

          db.fieldsOfStudy.push(created);

          return created;
        }),
      findById: (id) =>
        Effect.suspend(() => {
          const found = Option.getOrUndefined(
            Arr.findFirst(db.fieldsOfStudy, (row) => row.id === id)
          );

          return found === undefined
            ? Effect.fail(
                new NotFound({ entity: "FieldOfStudy", key: String(id) })
              )
            : Effect.succeed(found);
        }),
      listByDepartment: (departmentId) =>
        Effect.sync(() =>
          Arr.filter(
            db.fieldsOfStudy,
            (row) => row.departmentId === departmentId
          )
        ),
      rename: (id, names) =>
        Effect.suspend(() => {
          const index = Option.getOrElse(
            Arr.findFirstIndex(db.fieldsOfStudy, (row) => row.id === id),
            () => -1
          );

          const existing = db.fieldsOfStudy[index];

          if (existing === undefined) {
            return Effect.fail(
              new NotFound({ entity: "FieldOfStudy", key: String(id) })
            );
          }

          const renamed: FieldOfStudy = { ...existing, ...names };
          db.fieldsOfStudy[index] = renamed;

          return Effect.succeed(renamed);
        }),
    });

    const socialEvents = SocialEventRepository.of({
      create: (draft) =>
        Effect.sync(() => {
          const event: SocialEvent = {
            ...draft,
            id: SocialEventId.make(takeId()),
          };

          db.socialEvents.push(event);

          return event;
        }),
      list: ({ departmentId, semesterId }) =>
        Effect.sync(() =>
          Arr.filter(
            db.socialEvents,
            (event) =>
              event.departmentId === departmentId &&
              event.semesterId === semesterId
          )
        ),
    });

    const publicFiles = PublicFileRepository.of({
      findByKey: (key) =>
        Effect.sync(() =>
          Option.fromNullishOr(
            Option.getOrUndefined(
              Arr.findFirst(db.publicFiles, (row) => row.key === key)
            )
          )
        ),
      findByLegacyPath: (legacyPath) =>
        Effect.sync(() =>
          Option.fromNullishOr(
            Option.getOrUndefined(
              Arr.findFirst(
                db.publicFiles,
                (row) => row.legacyPath === legacyPath
              )
            )
          )
        ),
      register: (file) =>
        Effect.sync(() => {
          const existing = Option.getOrUndefined(
            Arr.findFirst(db.publicFiles, (row) => row.key === file.key)
          );

          if (existing !== undefined) {
            return existing;
          }

          db.publicFiles.push(file);

          return file;
        }),
    });

    const fileStore = FileStore.of({
      get: (key) =>
        Effect.sync(() =>
          Option.map(Option.fromNullishOr(db.objects.get(key)), (bytes) => ({
            body: Stream.make(bytes),
            size: bytes.byteLength,
          }))
        ),
      put: ({ key, bytes }) =>
        Effect.sync(() => {
          db.objects.set(key, bytes);
        }),
    });

    const outbox = Outbox.of({
      enqueue: (messages) =>
        Effect.forEach(messages, (message) =>
          isListed(message)
            ? Effect.sync(() => {
                const id = OutboxMessageId.make(`outbox-${takeId()}`);
                db.outbox.push({
                  attempts: 0,
                  claimToken: null,
                  id,
                  lastError: null,
                  message,
                  nextAttemptAt: null,
                  status: "pending",
                });

                return id;
              })
            : Effect.die(`${message._tag} is not a message of the catalog`)
        ),
    });

    const auditLog = AuditLog.of({
      latest: (limit) =>
        Effect.sync(() => Arr.take(Arr.reverse(db.audit), limit)),
      record: (entry) =>
        Effect.sync(() => {
          db.audit.push(entry);
        }),
    });

    const updateClaim = (
      id: OutboxMessageId,
      claimToken: OutboxClaimToken,
      update: (row: OutboxRow) => void
    ) =>
      Effect.sync(() => {
        const row = Option.getOrUndefined(
          Arr.findFirst(db.outbox, (candidate) => candidate.id === id)
        );

        if (row === undefined || row.claimToken !== claimToken) {
          return "claimLost" as const;
        }

        update(row);

        return "recorded" as const;
      });

    const rowOf = (id: OutboxMessageId) =>
      Option.getOrUndefined(
        Arr.findFirst(db.outbox, (candidate) => candidate.id === id)
      );

    const delivery = OutboxDelivery.of({
      claim: (id) =>
        Effect.map(DateTime.now, (now) => {
          const row = rowOf(id);

          if (row === undefined || row.status !== "pending") {
            return OutboxClaim.cases.Settled.make({});
          }

          if (row.claimToken !== null) {
            return OutboxClaim.cases.Held.make({});
          }

          row.attempts += 1;
          row.claimToken = OutboxClaimToken.make(`claim-${takeId()}`);

          return OutboxClaim.cases.Claimed.make({
            row: {
              attempts: row.attempts,
              claimToken: row.claimToken,
              createdAt: now,
              id: row.id,
              message: row.message,
            } satisfies ClaimedOutboxMessage,
          });
        }),
      markDead: (id) =>
        Effect.sync(() => {
          const row = rowOf(id);

          if (row === undefined || row.status !== "pending") {
            return "settled" as const;
          }

          if (row.claimToken !== null) {
            return "held" as const;
          }

          if (row.lastError === null) {
            return "settled" as const;
          }

          row.status = "dead";

          return "failed" as const;
        }),
      markDelivered: (id, claimToken) =>
        updateClaim(id, claimToken, (row) => {
          row.status = "delivered";
          row.claimToken = null;
        }),
      markFailed: (id, claimToken, error, next) =>
        updateClaim(id, claimToken, (row) => {
          row.claimToken = null;
          row.lastError = error;
          row.nextAttemptAt = next;
        }),
      markQueued: (ids) =>
        Effect.map(DateTime.now, (now) => {
          for (const row of db.outbox) {
            if (row.status === "pending" && ids.includes(row.id)) {
              row.queuedAt = now;
            }
          }
        }),
      recordFailure: (id, error, next) =>
        Effect.sync(() => {
          const row = rowOf(id);

          if (
            row === undefined ||
            row.status !== "pending" ||
            row.claimToken !== null
          ) {
            return "settled" as const;
          }

          row.lastError = error;
          row.nextAttemptAt = next;

          return "recorded" as const;
        }),
      stale: ({ before, limit }) =>
        Effect.sync(() =>
          Arr.take(
            Arr.map(
              Arr.filter(db.outbox, (row) => {
                const last = row.queuedAt ?? row.nextAttemptAt;

                return (
                  row.status === "pending" &&
                  row.claimToken === null &&
                  (last === null || !DateTime.isGreaterThan(last, before))
                );
              }),
              (row) => row.id
            ),
            limit
          )
        ),
    });

    const reports = OutboxReports.of({
      overview: Effect.map(DateTime.now, (now) => ({
        counts: {
          delivered: Arr.filter(db.outbox, (row) => row.status === "delivered")
            .length,
          failed: Arr.filter(db.outbox, (row) => row.status === "dead").length,
          pending: Arr.filter(db.outbox, (row) => row.status === "pending")
            .length,
        },
        open: Arr.map(
          Arr.filter(db.outbox, (row) => row.status !== "delivered"),
          (row) => ({
            attempts: row.attempts,
            id: row.id,
            kind: row.message._tag,
            lastError: row.lastError,
            nextAttemptAt: row.nextAttemptAt ?? now,
            queuedAt: row.queuedAt ?? null,
            state: deliveryState({
              lastError: row.lastError,
              queuedAt: row.queuedAt ?? null,
              status: row.status === "dead" ? "dead" : "pending",
            }),
          })
        ),
      })),
    });

    const admissionPeriods = AdmissionPeriodRepository.of({
      list: Effect.sync(() => db.admissionPeriods),
    });

    return Context.make(DepartmentRepository, departments).pipe(
      Context.add(AdmissionPeriodRepository, admissionPeriods),
      Context.add(SemesterRepository, semesters),
      Context.add(FieldOfStudyRepository, fieldsOfStudy),
      Context.add(SocialEventRepository, socialEvents),
      Context.add(PublicFileRepository, publicFiles),
      Context.add(FileStore, fileStore),
      Context.add(Outbox, outbox),
      Context.add(AuditLog, auditLog),
      Context.add(OutboxDelivery, delivery),
      Context.add(OutboxReports, reports)
    );
  })
);

/**
 * Test `Transactor`: provides `InTransaction` and snapshots the tables, so a
 * failed command leaves nothing behind (what `SqlClient.withTransaction` does
 * for real).
 */
const transactor = Layer.effect(
  Transactor,
  Effect.gen(function* transactor() {
    const db = yield* Memory;

    return Transactor.of({
      run: (program) =>
        Effect.gen(function* inTransaction() {
          const restoreTeams = yield* snapshotTeamTables(db.teams);

          const before: Omit<MemoryTables, "commits" | "nextId" | "teams"> = {
            admissionPeriods: [...db.admissionPeriods],
            audit: [...db.audit],
            departments: [...db.departments],
            fieldsOfStudy: [...db.fieldsOfStudy],
            objects: new Map(db.objects),
            outbox: Arr.map(db.outbox, (row) => ({ ...row })),
            publicFiles: [...db.publicFiles],
            semesters: [...db.semesters],
            socialEvents: [...db.socialEvents],
          };

          return yield* Effect.provideService(program, InTransaction, {
            kind: "database-transaction",
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                db.commits += 1;
              })
            ),
            Effect.onError(() =>
              Effect.andThen(
                Effect.sync(() => {
                  Object.assign(db, before);
                }),
                restoreTeams()
              )
            )
          );
        }),
    });
  })
);

/** The origin the in-memory site pretends to have (the "ending soon" e-mail's links start with it). */
const SITE_ORIGIN = "https://vektorprogrammet.test";

/**
 * Every in-memory service over `tables` (fresh by default), acting as `principal` (anonymous by default). The teams
 * repositories are the domain's fakes (`@vektorprogrammet/domain/testing`), over their own tables.
 */
export const memoryLayer = (
  tables: MemoryTables = makeTables(),
  principal: Principal = anonymous
) =>
  teamsInMemoryOver(tables.teams).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        repositories,
        transactor,
        Layer.mock(WorkspaceReports, { latest: Effect.succeedNone }),
        Layer.succeed(CurrentPrincipal, principal),
        Layer.succeed(SiteOrigin, SITE_ORIGIN)
      ).pipe(Layer.provideMerge(Layer.succeed(Memory, tables)))
    )
  );

/** A `FormData` from text fields and (optionally) uploaded files. */
export const form = (
  fields: Readonly<Record<string, string>> = {},
  files: Readonly<
    Record<
      string,
      { readonly bytes: Uint8Array<ArrayBuffer>; readonly name: string }
    >
  > = {}
): FormData => {
  const data = new FormData();

  for (const [name, value] of Rec.toEntries(fields)) {
    data.set(name, value);
  }

  for (const [name, file] of Rec.toEntries(files)) {
    data.set(name, new File([file.bytes], file.name));
  }

  return data;
};

// ---------------------------------------------------------------- fake fixtures

export const fakeDepartment = (
  id: number,
  city: string,
  overrides: Partial<Department> = {}
): Department => ({
  active: true,
  address: null,
  city,
  email: EmailAddress.make(`${city.toLowerCase()}@example.org`),
  id: DepartmentId.make(id),
  latitude: null,
  logoKey: null,
  longitude: null,
  name: `Vektor ${city}`,
  shortName: city.slice(0, 4).toUpperCase(),
  slackChannel: null,
  ...overrides,
});

export const fakeFieldOfStudy = (
  id: number,
  departmentId: number,
  name = `Linje ${id}`
): FieldOfStudy => ({
  departmentId: DepartmentId.make(departmentId),
  id: FieldOfStudyId.make(id),
  name,
  shortName: `L${id}`,
});

export const fakeKey = (
  seed: number,
  extension: "png" | "jpg" | "bin" | "pdf" | "gif" | "webp" = "png"
) => FileKey.make(`${seed.toString(16).padStart(64, "0")}.${extension}`);
