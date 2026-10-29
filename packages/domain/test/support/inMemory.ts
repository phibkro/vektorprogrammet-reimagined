import { assert } from "@effect/vitest";
/**
 * Test-only in-memory implementations of the domain's service interfaces.
 * Not exported from the package; `packages/db` provides the real Layers.
 */
import {
  Array as Arr,
  Context,
  Crypto,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Stream,
} from "effect";

import {
  AlreadyExists,
  AuditLog,
  CurrentPrincipal,
  DepartmentId,
  DepartmentRepository,
  EmailAddress,
  FieldOfStudyId,
  FieldOfStudyRepository,
  FileStore,
  InTransaction,
  NotFound,
  Outbox,
  OutboxMessageId,
  PersonId,
  Principal,
  PublicFileRepository,
  SemesterId,
  SemesterRepository,
  SiteOrigin,
  SlackChannel,
  SocialEventId,
  SocialEventRepository,
  TeamId,
  isListed,
} from "../../src/index.ts";
import type {
  AuditEntry,
  Department,
  FieldOfStudy,
  FileKey,
  OutboxMessage,
  PublicFile,
  SocialEvent,
  StoredContentType,
  StoredSemester,
} from "../../src/index.ts";
import { TeamsInMemory } from "./teamsInMemory.ts";

export interface StoredBytes {
  readonly bytes: Uint8Array;
  readonly contentType: StoredContentType;
}

/** All in-memory tables; tests read them to assert what was (not) written. */
export class TestDb extends Context.Service<
  TestDb,
  {
    readonly departments: Ref.Ref<readonly Department[]>;
    readonly semesters: Ref.Ref<readonly StoredSemester[]>;
    readonly fieldsOfStudy: Ref.Ref<readonly FieldOfStudy[]>;
    readonly socialEvents: Ref.Ref<readonly SocialEvent[]>;
    readonly publicFiles: Ref.Ref<readonly PublicFile[]>;
    readonly objects: Ref.Ref<ReadonlyMap<FileKey, StoredBytes>>;
    readonly outbox: Ref.Ref<readonly OutboxMessage[]>;
    readonly audit: Ref.Ref<readonly AuditEntry[]>;
    readonly nextId: Ref.Ref<number>;
  }
>()("test/TestDb") {
  static readonly layer = Layer.effect(
    TestDb,
    Effect.gen(function* layer() {
      return TestDb.of({
        audit: yield* Ref.make<readonly AuditEntry[]>([]),
        departments: yield* Ref.make<readonly Department[]>([]),
        fieldsOfStudy: yield* Ref.make<readonly FieldOfStudy[]>([]),
        nextId: yield* Ref.make(1),
        objects: yield* Ref.make<ReadonlyMap<FileKey, StoredBytes>>(new Map()),
        outbox: yield* Ref.make<readonly OutboxMessage[]>([]),
        publicFiles: yield* Ref.make<readonly PublicFile[]>([]),
        semesters: yield* Ref.make<readonly StoredSemester[]>([]),
        socialEvents: yield* Ref.make<readonly SocialEvent[]>([]),
      });
    })
  );
}

export const departmentForTest = (
  id: DepartmentId,
  city: string,
  shortName = city.toUpperCase(),
  slackChannel: string | null = null
): Department => ({
  active: true,
  address: null,
  city,
  email: EmailAddress.make(`${city.toLowerCase()}@example.org`),
  id,
  latitude: null,
  logoKey: null,
  longitude: null,
  name: `Vektor ${city}`,
  shortName,
  slackChannel: slackChannel === null ? null : SlackChannel.make(slackChannel),
});

const nextId = (db: TestDb["Service"]) =>
  Ref.getAndUpdate(db.nextId, (id) => id + 1);

const findOr = <A>(
  items: readonly A[],
  predicate: (item: A) => boolean,
  error: NotFound
) => {
  const found = Option.getOrUndefined(Arr.findFirst(items, predicate));

  return found === undefined ? Effect.fail(error) : Effect.succeed(found);
};

const sameSemester = (
  a: { term: string; year: number },
  b: { term: string; year: number }
) => a.term === b.term && a.year === b.year;

const notFoundFieldOfStudy = (id: FieldOfStudyId) =>
  new NotFound({ entity: "FieldOfStudy", key: String(id) });

const DepartmentRepositoryTest = Layer.effect(
  DepartmentRepository,
  Effect.gen(function* DepartmentRepositoryTest() {
    const db = yield* TestDb;

    const cityTaken = (city: string, except?: DepartmentId) =>
      Effect.map(Ref.get(db.departments), (rows) =>
        Arr.some(rows, (row) => row.city === city && row.id !== except)
      );

    return DepartmentRepository.of({
      create: (draft) =>
        Effect.gen(function* create() {
          if (yield* cityTaken(draft.city)) {
            return yield* new AlreadyExists({
              entity: "Department",
              key: draft.city,
              message: "city taken",
            });
          }

          const created: Department = {
            id: DepartmentId.make(yield* nextId(db)),
            ...draft,
          };

          yield* Ref.update(db.departments, (rows) => [...rows, created]);

          return created;
        }),
      findById: (id) =>
        Effect.flatMap(Ref.get(db.departments), (rows) =>
          findOr(
            rows,
            (row) => row.id === id,
            new NotFound({ entity: "Department", key: String(id) })
          )
        ),
      list: Ref.get(db.departments),
      update: (id, draft) =>
        Effect.gen(function* update() {
          const rows = yield* Ref.get(db.departments);
          yield* findOr(
            rows,
            (row) => row.id === id,
            new NotFound({ entity: "Department", key: String(id) })
          );

          if (yield* cityTaken(draft.city, id)) {
            return yield* new AlreadyExists({
              entity: "Department",
              key: draft.city,
              message: "city taken",
            });
          }

          const updated: Department = { id, ...draft };
          yield* Ref.set(
            db.departments,
            Arr.map(rows, (row) => (row.id === id ? updated : row))
          );

          return updated;
        }),
    });
  })
);

const SemesterRepositoryTest = Layer.effect(
  SemesterRepository,
  Effect.gen(function* SemesterRepositoryTest() {
    const db = yield* TestDb;

    return SemesterRepository.of({
      // Atomic like `INSERT … ON CONFLICT DO UPDATE … RETURNING`.
      ensure: (semester) =>
        Effect.gen(function* ensure() {
          const id = SemesterId.make(yield* nextId(db));

          return yield* Ref.modify(db.semesters, (rows) => {
            const existing = Option.getOrUndefined(
              Arr.findFirst(rows, (row) => sameSemester(row, semester))
            );

            if (existing !== undefined) {
              return [existing, rows];
            }

            const created: StoredSemester = { id, ...semester };

            return [created, [...rows, created]];
          });
        }),
      find: (semester) =>
        Effect.map(Ref.get(db.semesters), (rows) =>
          Option.fromNullishOr(
            Option.getOrUndefined(
              Arr.findFirst(rows, (row) => sameSemester(row, semester))
            )
          )
        ),
      list: Ref.get(db.semesters),
    });
  })
);

const FieldOfStudyRepositoryTest = Layer.effect(
  FieldOfStudyRepository,
  Effect.gen(function* FieldOfStudyRepositoryTest() {
    const db = yield* TestDb;

    return FieldOfStudyRepository.of({
      create: (draft) =>
        Effect.gen(function* create() {
          const created: FieldOfStudy = {
            id: FieldOfStudyId.make(yield* nextId(db)),
            ...draft,
          };

          yield* Ref.update(db.fieldsOfStudy, (rows) => [...rows, created]);

          return created;
        }),
      findById: (id) =>
        Effect.flatMap(Ref.get(db.fieldsOfStudy), (rows) =>
          findOr(rows, (row) => row.id === id, notFoundFieldOfStudy(id))
        ),
      listByDepartment: (departmentId) =>
        Effect.map(Ref.get(db.fieldsOfStudy), (rows) =>
          Arr.filter(rows, (row) => row.departmentId === departmentId)
        ),
      rename: (id, names) =>
        Effect.gen(function* rename() {
          const rows = yield* Ref.get(db.fieldsOfStudy);

          const existing = yield* findOr(
            rows,
            (row) => row.id === id,
            notFoundFieldOfStudy(id)
          );

          const renamed: FieldOfStudy = { ...existing, ...names };
          yield* Ref.set(
            db.fieldsOfStudy,
            Arr.map(rows, (row) => (row.id === id ? renamed : row))
          );

          return renamed;
        }),
    });
  })
);

const SocialEventRepositoryTest = Layer.effect(
  SocialEventRepository,
  Effect.gen(function* SocialEventRepositoryTest() {
    const db = yield* TestDb;

    return SocialEventRepository.of({
      create: (draft) =>
        Effect.gen(function* create() {
          const created: SocialEvent = {
            id: SocialEventId.make(yield* nextId(db)),
            ...draft,
          };

          yield* Ref.update(db.socialEvents, (rows) => [...rows, created]);

          return created;
        }),
      list: (filter) =>
        Effect.map(Ref.get(db.socialEvents), (rows) =>
          Arr.filter(
            rows,
            (row) =>
              row.departmentId === filter.departmentId &&
              row.semesterId === filter.semesterId
          )
        ),
    });
  })
);

const PublicFileRepositoryTest = Layer.effect(
  PublicFileRepository,
  Effect.gen(function* PublicFileRepositoryTest() {
    const db = yield* TestDb;

    return PublicFileRepository.of({
      findByKey: (key) =>
        Effect.map(Ref.get(db.publicFiles), (rows) =>
          Option.fromNullishOr(
            Option.getOrUndefined(Arr.findFirst(rows, (row) => row.key === key))
          )
        ),
      findByLegacyPath: (legacyPath) =>
        Effect.map(Ref.get(db.publicFiles), (rows) =>
          Option.fromNullishOr(
            Option.getOrUndefined(
              Arr.findFirst(rows, (row) => row.legacyPath === legacyPath)
            )
          )
        ),
      register: (file) =>
        Ref.modify(db.publicFiles, (rows) => {
          const existing = Option.getOrUndefined(
            Arr.findFirst(rows, (row) => row.key === file.key)
          );

          return existing === undefined
            ? [file, [...rows, file]]
            : [existing, rows];
        }),
    });
  })
);

const FileStoreTest = Layer.effect(
  FileStore,
  Effect.gen(function* FileStoreTest() {
    const db = yield* TestDb;

    return FileStore.of({
      get: (key) =>
        Effect.map(Ref.get(db.objects), (objects) =>
          Option.map(Option.fromNullishOr(objects.get(key)), (stored) => ({
            body: Stream.make(stored.bytes),
            size: stored.bytes.byteLength,
          }))
        ),
      put: ({ key, bytes, contentType }) =>
        Ref.update(
          db.objects,
          (objects) => new Map([...objects, [key, { bytes, contentType }]])
        ),
    });
  })
);

const OutboxTest = Layer.effect(
  Outbox,
  Effect.gen(function* OutboxTest() {
    const db = yield* TestDb;

    return Outbox.of({
      enqueue: (messages) =>
        Effect.gen(function* enqueue() {
          const listed = yield* Effect.forEach(messages, (message) =>
            isListed(message)
              ? Effect.succeed(message)
              : Effect.die(`${message._tag} is not a message of the catalog`)
          );

          const start = (yield* Ref.get(db.outbox)).length;
          yield* Ref.update(db.outbox, (rows) => [...rows, ...listed]);

          return Arr.map(listed, (_, index) =>
            OutboxMessageId.make(`outbox-${start + index + 1}`)
          );
        }),
    });
  })
);

const AuditLogTest = Layer.effect(
  AuditLog,
  Effect.gen(function* AuditLogTest() {
    const db = yield* TestDb;

    return AuditLog.of({
      latest: (limit) =>
        Effect.map(Ref.get(db.audit), (rows) =>
          Arr.take(Arr.reverse(rows), limit)
        ),
      record: (entry) => Ref.update(db.audit, (rows) => [...rows, entry]),
    });
  })
);

/** Stands in for `packages/db`'s transaction runner. */
const InTransactionTest = Layer.succeed(InTransaction)({
  kind: "database-transaction",
});

/** Web Crypto from the Node test runtime (Workers provide the same API). */
const CryptoTest = Layer.succeed(Crypto.Crypto)(
  Crypto.make({
    digest: (algorithm, data) =>
      Effect.map(
        Effect.promise(
          globalThis.crypto.subtle.digest.bind(
            globalThis.crypto.subtle,
            algorithm,
            new Uint8Array(data)
          )
        ),
        (buffer) => new Uint8Array(buffer)
      ),
    randomBytes: (size) =>
      globalThis.crypto.getRandomValues(new Uint8Array(size)),
  })
);

/** The origin that links in test messages carry. */
export const SITE_ORIGIN = "https://vektorprogrammet.test";

/** The repositories of the Phase 1 domains; `TestDb` stays visible for assertions. */
const Phase1Services = Layer.mergeAll(
  DepartmentRepositoryTest,
  SemesterRepositoryTest,
  FieldOfStudyRepositoryTest,
  SocialEventRepositoryTest,
  PublicFileRepositoryTest,
  FileStoreTest,
  OutboxTest,
  AuditLogTest
).pipe(Layer.provideMerge(TestDb.layer));

/** Every service except `CurrentPrincipal`; `TestDb` and `TeamTables` stay visible for assertions. */
export const TestServices = TeamsInMemory.pipe(
  Layer.provideMerge(Phase1Services),
  Layer.merge(InTransactionTest),
  Layer.merge(CryptoTest),
  Layer.merge(Layer.succeed(SiteOrigin)(SITE_ORIGIN))
);

/** Runs `effect` as `principal`. */
export const asPrincipal =
  (principal: Principal) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, CurrentPrincipal, principal);

// Fake same-shape identities; no legacy personal data.
export const TRONDHEIM = DepartmentId.make(1);

export const BERGEN = DepartmentId.make(2);

export const LATE = DateTime.makeUnsafe("2099-12-31T23:59:59Z");

/** A person holding an admin place. */
export const admin = Principal.cases.Person.make({
  adminUntil: LATE,
  memberships: [],
  personId: PersonId.make(100),
});

/** A leader of a team in Trondheim. */
export const teamLeaderTrondheim = Principal.cases.Person.make({
  memberships: [
    {
      departmentId: TRONDHEIM,
      function: "recruitment",
      leader: true,
      teamId: TeamId.make(10),
    },
  ],
  personId: PersonId.make(102),
});

/** A member of a team in Bergen, not its leader. */
export const teamMemberBergen = Principal.cases.Person.make({
  memberships: [
    {
      departmentId: BERGEN,
      function: "recruitment",
      leader: false,
      teamId: TeamId.make(20),
    },
  ],
  personId: PersonId.make(103),
});

/** Seeds rows directly, bypassing commands. */
export const seed = {
  department: (department: Department) =>
    TestDb.use((db) =>
      Ref.update(db.departments, (rows) => [...rows, department])
    ),
  fieldOfStudy: (field: FieldOfStudy) =>
    TestDb.use((db) =>
      Ref.update(db.fieldsOfStudy, (rows) => [...rows, field])
    ),
  publicFile: (file: PublicFile) =>
    TestDb.use((db) => Ref.update(db.publicFiles, (rows) => [...rows, file])),
};

/** Reads one in-memory table. */
export const table = <A>(select: (db: TestDb["Service"]) => Ref.Ref<A>) =>
  TestDb.use((db) => Ref.get(select(db)));

/** The action of each audit row, in insertion order. */
export const auditActions = Effect.map(
  table((db) => db.audit),
  (audit) => Arr.map(audit, (entry) => entry.action)
);

/** Asserts all supplied in-memory rows remain absent after a refused command. */
export const assertNoRows = (tables: readonly (readonly unknown[])[]) => {
  assert.deepStrictEqual(
    tables,
    Arr.map(tables, () => [])
  );
};

export const assertAuditEntries = (
  audit: readonly AuditEntry[],
  expected: readonly (readonly [string, string])[]
) => {
  assert.deepStrictEqual(
    Arr.map(audit, (entry) => [entry.action, entry.entityKey]),
    expected
  );
};

/** A UTC instant from an ISO string (fixtures only). */
export const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso);

/** The failure's `_tag`, `"defect"` for a die, or `"success"`. */
export const failureTag = (
  exit: Exit.Exit<unknown, { readonly _tag: string }>
): string =>
  Exit.isSuccess(exit)
    ? "success"
    : Option.match(Exit.findErrorOption(exit), {
        onNone: () => "defect",
        onSome: (error) => error._tag,
      });
