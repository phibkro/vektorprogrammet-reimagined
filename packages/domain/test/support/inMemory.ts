/**
 * Test-only in-memory implementations of the domain's service interfaces.
 * Not exported from the package; `packages/db` provides the real Layers.
 */
import { Context, Crypto, DateTime, Effect, Exit, Layer, Option, Ref, Stream } from "effect";
import {
  AlreadyExists,
  ArticleId,
  ArticleRepository,
  AuditLog,
  CurrentActor,
  DepartmentId,
  DepartmentRepository,
  FieldOfStudyId,
  FieldOfStudyRepository,
  FileStore,
  InTransaction,
  NotFound,
  Outbox,
  OutboxMessageId,
  PublicFileRepository,
  SemesterId,
  SemesterRepository,
  SocialEventId,
  SocialEventRepository,
  SponsorId,
  SponsorRepository,
  StaticContentRepository,
  UserId,
  type Actor,
  type Article,
  type AuditEntry,
  type Department,
  type FieldOfStudy,
  type FileKey,
  type OutboxMessage,
  type PublicFile,
  type SanitizedHtml,
  type SocialEvent,
  type Sponsor,
  type StaticContent,
  type StaticContentKey,
  type StoredContentType,
  type StoredSemester,
  type Staff,
} from "../../src/index.ts";

export interface StoredBytes {
  readonly bytes: Uint8Array;
  readonly contentType: StoredContentType;
}

/** All in-memory tables; tests read them to assert what was (not) written. */
export class TestDb extends Context.Service<
  TestDb,
  {
    readonly departments: Ref.Ref<ReadonlyArray<Department>>;
    readonly semesters: Ref.Ref<ReadonlyArray<StoredSemester>>;
    readonly fieldsOfStudy: Ref.Ref<ReadonlyArray<FieldOfStudy>>;
    readonly articles: Ref.Ref<ReadonlyArray<Article>>;
    readonly staticContent: Ref.Ref<ReadonlyArray<StaticContent>>;
    readonly sponsors: Ref.Ref<ReadonlyArray<Sponsor>>;
    readonly socialEvents: Ref.Ref<ReadonlyArray<SocialEvent>>;
    readonly publicFiles: Ref.Ref<ReadonlyArray<PublicFile>>;
    readonly objects: Ref.Ref<ReadonlyMap<FileKey, StoredBytes>>;
    readonly outbox: Ref.Ref<ReadonlyArray<OutboxMessage>>;
    readonly audit: Ref.Ref<ReadonlyArray<AuditEntry>>;
    readonly nextId: Ref.Ref<number>;
  }
>()("test/TestDb") {
  static readonly layer = Layer.effect(
    TestDb,
    Effect.gen(function* () {
      return TestDb.of({
        departments: yield* Ref.make<ReadonlyArray<Department>>([]),
        semesters: yield* Ref.make<ReadonlyArray<StoredSemester>>([]),
        fieldsOfStudy: yield* Ref.make<ReadonlyArray<FieldOfStudy>>([]),
        articles: yield* Ref.make<ReadonlyArray<Article>>([]),
        staticContent: yield* Ref.make<ReadonlyArray<StaticContent>>([]),
        sponsors: yield* Ref.make<ReadonlyArray<Sponsor>>([]),
        socialEvents: yield* Ref.make<ReadonlyArray<SocialEvent>>([]),
        publicFiles: yield* Ref.make<ReadonlyArray<PublicFile>>([]),
        objects: yield* Ref.make<ReadonlyMap<FileKey, StoredBytes>>(new Map()),
        outbox: yield* Ref.make<ReadonlyArray<OutboxMessage>>([]),
        audit: yield* Ref.make<ReadonlyArray<AuditEntry>>([]),
        nextId: yield* Ref.make(1),
      });
    }),
  );
}

const nextId = (db: TestDb["Service"]) => Ref.getAndUpdate(db.nextId, (id) => id + 1);

const findOr = <A>(items: ReadonlyArray<A>, predicate: (item: A) => boolean, error: NotFound) => {
  const found = items.find(predicate);
  return found === undefined ? Effect.fail(error) : Effect.succeed(found);
};

const DepartmentRepositoryTest = Layer.effect(
  DepartmentRepository,
  Effect.gen(function* () {
    const db = yield* TestDb;
    const cityTaken = (city: string, except?: DepartmentId) =>
      Effect.map(Ref.get(db.departments), (rows) =>
        rows.some((row) => row.city === city && row.id !== except),
      );
    return DepartmentRepository.of({
      list: Ref.get(db.departments),
      findById: (id) =>
        Effect.flatMap(Ref.get(db.departments), (rows) =>
          findOr(
            rows,
            (row) => row.id === id,
            new NotFound({ entity: "Department", key: String(id) }),
          ),
        ),
      create: (draft) =>
        Effect.gen(function* () {
          if (yield* cityTaken(draft.city)) {
            return yield* new AlreadyExists({
              entity: "Department",
              key: draft.city,
              message: "city taken",
            });
          }
          const created: Department = { id: DepartmentId.make(yield* nextId(db)), ...draft };
          yield* Ref.update(db.departments, (rows) => [...rows, created]);
          return created;
        }),
      update: (id, draft) =>
        Effect.gen(function* () {
          const rows = yield* Ref.get(db.departments);
          yield* findOr(
            rows,
            (row) => row.id === id,
            new NotFound({ entity: "Department", key: String(id) }),
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
            rows.map((row) => (row.id === id ? updated : row)),
          );
          return updated;
        }),
    });
  }),
);

const SemesterRepositoryTest = Layer.effect(
  SemesterRepository,
  Effect.gen(function* () {
    const db = yield* TestDb;
    const same = (a: { term: string; year: number }, b: { term: string; year: number }) =>
      a.term === b.term && a.year === b.year;
    return SemesterRepository.of({
      list: Ref.get(db.semesters),
      find: (semester) =>
        Effect.map(Ref.get(db.semesters), (rows) =>
          Option.fromNullishOr(rows.find((row) => same(row, semester))),
        ),
      create: (semester) =>
        Effect.gen(function* () {
          const id = SemesterId.make(yield* nextId(db));
          const created = yield* Ref.modify(db.semesters, (rows) =>
            rows.some((row) => same(row, semester))
              ? [Option.none<StoredSemester>(), rows]
              : [Option.some({ id, ...semester }), [...rows, { id, ...semester }]],
          );
          if (Option.isNone(created)) {
            return yield* new AlreadyExists({
              entity: "Semester",
              key: `${semester.term} ${semester.year}`,
              message: "unique (term, year)",
            });
          }
          return created.value;
        }),
      // Atomic like `INSERT … ON CONFLICT DO NOTHING` + select.
      ensure: (semester) =>
        Effect.gen(function* () {
          const id = SemesterId.make(yield* nextId(db));
          return yield* Ref.modify(db.semesters, (rows) => {
            const existing = rows.find((row) => same(row, semester));
            if (existing !== undefined) return [existing, rows];
            const created: StoredSemester = { id, ...semester };
            return [created, [...rows, created]];
          });
        }),
    });
  }),
);

const FieldOfStudyRepositoryTest = Layer.effect(
  FieldOfStudyRepository,
  Effect.gen(function* () {
    const db = yield* TestDb;
    const notFound = (id: FieldOfStudyId) =>
      new NotFound({ entity: "FieldOfStudy", key: String(id) });
    return FieldOfStudyRepository.of({
      listByDepartment: (departmentId) =>
        Effect.map(Ref.get(db.fieldsOfStudy), (rows) =>
          rows.filter((row) => row.departmentId === departmentId),
        ),
      findById: (id) =>
        Effect.flatMap(Ref.get(db.fieldsOfStudy), (rows) =>
          findOr(rows, (row) => row.id === id, notFound(id)),
        ),
      create: (draft) =>
        Effect.gen(function* () {
          const created: FieldOfStudy = { id: FieldOfStudyId.make(yield* nextId(db)), ...draft };
          yield* Ref.update(db.fieldsOfStudy, (rows) => [...rows, created]);
          return created;
        }),
      rename: (id, names) =>
        Effect.gen(function* () {
          const rows = yield* Ref.get(db.fieldsOfStudy);
          const existing = yield* findOr(rows, (row) => row.id === id, notFound(id));
          const renamed: FieldOfStudy = { ...existing, ...names };
          yield* Ref.set(
            db.fieldsOfStudy,
            rows.map((row) => (row.id === id ? renamed : row)),
          );
          return renamed;
        }),
    });
  }),
);

const ArticleRepositoryTest = Layer.effect(
  ArticleRepository,
  Effect.gen(function* () {
    const db = yield* TestDb;
    const notFound = (id: ArticleId) => new NotFound({ entity: "Article", key: String(id) });
    return ArticleRepository.of({
      create: (draft) =>
        Effect.gen(function* () {
          const rows = yield* Ref.get(db.articles);
          if (rows.some((row) => row.slug === draft.slug)) {
            return yield* new AlreadyExists({
              entity: "Article",
              key: draft.slug,
              message: "slug taken",
            });
          }
          const created: Article = { id: ArticleId.make(yield* nextId(db)), ...draft };
          yield* Ref.set(db.articles, [...rows, created]);
          return created;
        }),
      findById: (id) =>
        Effect.flatMap(Ref.get(db.articles), (rows) =>
          findOr(rows, (row) => row.id === id, notFound(id)),
        ),
      findBySlug: (slug) =>
        Effect.map(Ref.get(db.articles), (rows) =>
          Option.fromNullishOr(rows.find((row) => row.slug === slug)),
        ),
      slugsLike: (base) =>
        Effect.map(Ref.get(db.articles), (rows) =>
          rows
            .map((row) => row.slug)
            .filter((slug) => slug === base || slug.startsWith(`${base}-`)),
        ),
      listPublished: Effect.map(Ref.get(db.articles), (rows) =>
        rows.filter((row) => row.published),
      ),
      setPublished: (id, published) =>
        Effect.gen(function* () {
          const rows = yield* Ref.get(db.articles);
          const existing = yield* findOr(rows, (row) => row.id === id, notFound(id));
          const updated: Article = { ...existing, published };
          yield* Ref.set(
            db.articles,
            rows.map((row) => (row.id === id ? updated : row)),
          );
          return updated;
        }),
    });
  }),
);

const StaticContentRepositoryTest = Layer.effect(
  StaticContentRepository,
  Effect.gen(function* () {
    const db = yield* TestDb;
    return StaticContentRepository.of({
      find: (key: StaticContentKey) =>
        Effect.map(Ref.get(db.staticContent), (rows) =>
          Option.fromNullishOr(rows.find((row) => row.key === key)),
        ),
      upsert: (key: StaticContentKey, html: SanitizedHtml) =>
        Ref.modify(db.staticContent, (rows) => {
          const saved: StaticContent = { key, html };
          return [saved, [...rows.filter((row) => row.key !== key), saved]];
        }),
    });
  }),
);

const SponsorRepositoryTest = Layer.effect(
  SponsorRepository,
  Effect.gen(function* () {
    const db = yield* TestDb;
    return SponsorRepository.of({
      list: Ref.get(db.sponsors),
      create: (draft) =>
        Effect.gen(function* () {
          const created: Sponsor = { id: SponsorId.make(yield* nextId(db)), ...draft };
          yield* Ref.update(db.sponsors, (rows) => [...rows, created]);
          return created;
        }),
    });
  }),
);

const SocialEventRepositoryTest = Layer.effect(
  SocialEventRepository,
  Effect.gen(function* () {
    const db = yield* TestDb;
    return SocialEventRepository.of({
      list: (filter) =>
        Effect.map(Ref.get(db.socialEvents), (rows) =>
          rows.filter(
            (row) =>
              row.departmentId === filter.departmentId && row.semesterId === filter.semesterId,
          ),
        ),
      create: (draft) =>
        Effect.gen(function* () {
          const created: SocialEvent = { id: SocialEventId.make(yield* nextId(db)), ...draft };
          yield* Ref.update(db.socialEvents, (rows) => [...rows, created]);
          return created;
        }),
    });
  }),
);

const PublicFileRepositoryTest = Layer.effect(
  PublicFileRepository,
  Effect.gen(function* () {
    const db = yield* TestDb;
    return PublicFileRepository.of({
      findByKey: (key) =>
        Effect.map(Ref.get(db.publicFiles), (rows) =>
          Option.fromNullishOr(rows.find((row) => row.key === key)),
        ),
      findByLegacyPath: (legacyPath) =>
        Effect.map(Ref.get(db.publicFiles), (rows) =>
          Option.fromNullishOr(rows.find((row) => row.legacyPath === legacyPath)),
        ),
      register: (file) =>
        Ref.modify(db.publicFiles, (rows) => {
          const existing = rows.find((row) => row.key === file.key);
          return existing === undefined ? [file, [...rows, file]] : [existing, rows];
        }),
    });
  }),
);

const FileStoreTest = Layer.effect(
  FileStore,
  Effect.gen(function* () {
    const db = yield* TestDb;
    return FileStore.of({
      put: ({ key, bytes, contentType }) =>
        Ref.update(db.objects, (objects) => new Map([...objects, [key, { bytes, contentType }]])),
      get: (key) =>
        Effect.map(Ref.get(db.objects), (objects) =>
          Option.map(Option.fromNullishOr(objects.get(key)), (stored) => ({
            body: Stream.make(stored.bytes),
            size: stored.bytes.byteLength,
          })),
        ),
    });
  }),
);

const OutboxTest = Layer.effect(
  Outbox,
  Effect.gen(function* () {
    const db = yield* TestDb;
    return Outbox.of({
      enqueue: (messages) =>
        Effect.gen(function* () {
          const start = (yield* Ref.get(db.outbox)).length;
          yield* Ref.update(db.outbox, (rows) => [...rows, ...messages]);
          return messages.map((_, index) => OutboxMessageId.make(`outbox-${start + index + 1}`));
        }),
    });
  }),
);

const AuditLogTest = Layer.effect(
  AuditLog,
  Effect.gen(function* () {
    const db = yield* TestDb;
    return AuditLog.of({ record: (entry) => Ref.update(db.audit, (rows) => [...rows, entry]) });
  }),
);

/** Stands in for `packages/db`'s transaction runner. */
const InTransactionTest = Layer.succeed(InTransaction)({ kind: "database-transaction" });

/** Web Crypto from the Node test runtime (Workers provide the same API). */
export const CryptoTest = Layer.succeed(Crypto.Crypto)(
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.map(
        Effect.promise(() => globalThis.crypto.subtle.digest(algorithm, new Uint8Array(data))),
        (buffer) => new Uint8Array(buffer),
      ),
  }),
);

/** Every service except `CurrentActor`; `TestDb` stays visible for assertions. */
export const TestServices = Layer.mergeAll(
  DepartmentRepositoryTest,
  SemesterRepositoryTest,
  FieldOfStudyRepositoryTest,
  ArticleRepositoryTest,
  StaticContentRepositoryTest,
  SponsorRepositoryTest,
  SocialEventRepositoryTest,
  PublicFileRepositoryTest,
  FileStoreTest,
  OutboxTest,
  AuditLogTest,
).pipe(Layer.provideMerge(TestDb.layer), Layer.merge(InTransactionTest), Layer.merge(CryptoTest));

/** Runs `effect` as `actor`. */
export const asActor =
  (actor: Actor) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, CurrentActor, actor);

// Fake same-shape identities; no legacy personal data.
export const TRONDHEIM = DepartmentId.make(1);
export const BERGEN = DepartmentId.make(2);

const staff = (fields: Omit<Staff, "_tag">): Staff => ({ _tag: "Staff", ...fields });

export const admin = staff({
  userId: UserId.make(100),
  departmentId: TRONDHEIM,
  role: "admin",
  executiveBoard: false,
});
export const boardMember = staff({
  userId: UserId.make(101),
  departmentId: TRONDHEIM,
  role: "teamMember",
  executiveBoard: true,
});
export const teamLeaderTrondheim = staff({
  userId: UserId.make(102),
  departmentId: TRONDHEIM,
  role: "teamLeader",
  executiveBoard: false,
});
export const teamMemberBergen = staff({
  userId: UserId.make(103),
  departmentId: BERGEN,
  role: "teamMember",
  executiveBoard: false,
});

/** Seeds rows directly, bypassing commands. */
export const seed = {
  department: (department: Department) =>
    TestDb.use((db) => Ref.update(db.departments, (rows) => [...rows, department])),
  publicFile: (file: PublicFile) =>
    TestDb.use((db) => Ref.update(db.publicFiles, (rows) => [...rows, file])),
  article: (article: Article) =>
    TestDb.use((db) => Ref.update(db.articles, (rows) => [...rows, article])),
  fieldOfStudy: (field: FieldOfStudy) =>
    TestDb.use((db) => Ref.update(db.fieldsOfStudy, (rows) => [...rows, field])),
};

/** Reads one in-memory table. */
export const table = <A>(select: (db: TestDb["Service"]) => Ref.Ref<A>) =>
  TestDb.use((db) => Ref.get(select(db)));

/** A UTC instant from an ISO string (fixtures only). */
export const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso);

/** The failure's `_tag`, `"defect"` for a die, or `"success"`. */
export const failureTag = (exit: Exit.Exit<unknown, { readonly _tag: string }>): string =>
  Exit.isSuccess(exit)
    ? "success"
    : Option.match(Exit.findErrorOption(exit), {
        onNone: () => "defect",
        onSome: (error) => error._tag,
      });
