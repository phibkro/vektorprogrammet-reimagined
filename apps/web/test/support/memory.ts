/**
 * In-memory Layers for apps/web tests (Node, `vp test`). Real database
 * behaviour is `packages/db`'s job; these fakes implement the domain's
 * service contracts just far enough for the web runtime, routes and outbox
 * delivery to be exercised. Every value is a fake same-shape value.
 */
import { OutboxClaimToken, OutboxDelivery } from "@vektorprogrammet/db";
import type { ClaimedOutboxMessage } from "@vektorprogrammet/db";
import {
  AdmissionPeriodRepository,
  AlreadyExists,
  ArticleId,
  ArticleRepository,
  AuditLog,
  CurrentActor,
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
  OutboxMessageId,
  PublicFileRepository,
  sanitizeRichText,
  SemesterId,
  SemesterRepository,
  Slug,
  SocialEventId,
  SocialEventRepository,
  SponsorId,
  SponsorRepository,
  StaticContentRepository,
  anonymous,
} from "@vektorprogrammet/domain";
import type {
  Actor,
  AdmissionPeriod,
  Article,
  AuditEntry,
  Department,
  EntityName,
  FieldOfStudy,
  OutboxMessage,
  PublicFile,
  SocialEvent,
  Sponsor,
  StaticContent,
  StoredSemester,
} from "@vektorprogrammet/domain";
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

import { Transactor } from "../../src/server/transactor";

interface OutboxRow {
  readonly id: OutboxMessageId;
  readonly message: OutboxMessage;
  attempts: number;
  status: "pending" | "delivered" | "dead";
  claimToken: OutboxClaimToken | null;
  nextAttemptAt: DateTime.Utc | null;
  lastError: string | null;
}

/** The fake tables; tests seed and inspect them directly. */
export interface MemoryTables {
  departments: Department[];
  admissionPeriods: AdmissionPeriod[];
  articles: Article[];
  staticContent: StaticContent[];
  publicFiles: PublicFile[];
  objects: Map<string, Uint8Array>;
  outbox: OutboxRow[];
  audit: AuditEntry[];
  semesters: StoredSemester[];
  fieldsOfStudy: FieldOfStudy[];
  sponsors: Sponsor[];
  socialEvents: SocialEvent[];
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
  articles: [],
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
  sponsors: [],
  staticContent: [],
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

    const articles = ArticleRepository.of({
      create: (draft) =>
        Effect.suspend(() => {
          if (Arr.some(db.articles, (row) => row.slug === draft.slug)) {
            return Effect.fail(
              new AlreadyExists({
                entity: "Article",
                key: draft.slug,
                message: "Slug finnes.",
              })
            );
          }

          const created: Article = { id: ArticleId.make(takeId()), ...draft };
          db.articles.push(created);

          return Effect.succeed(created);
        }),
      findById: findById(db.articles, "Article"),
      findBySlug: (slug) =>
        Effect.sync(() =>
          Option.fromNullishOr(
            Option.getOrUndefined(
              Arr.findFirst(db.articles, (row) => row.slug === slug)
            )
          )
        ),
      listPublished: Effect.sync(() =>
        Arr.filter(db.articles, (row) => row.published)
      ),
      setPublished: (id, published) =>
        Effect.suspend(() => {
          const index = Option.getOrElse(
            Arr.findFirstIndex(db.articles, (row) => row.id === id),
            () => -1
          );

          if (index === -1) {
            return Effect.fail(
              new NotFound({ entity: "Article", key: String(id) })
            );
          }

          const updated: Article = { ...db.articles[index], published };
          db.articles[index] = updated;

          return Effect.succeed(updated);
        }),
      slugsLike: (base) =>
        Effect.sync(() =>
          Arr.filter(
            Arr.map(db.articles, (row) => row.slug),
            (slug) => slug === base || slug.startsWith(`${base}-`)
          )
        ),
    });

    const staticContent = StaticContentRepository.of({
      find: (key) =>
        Effect.sync(() =>
          Option.fromNullishOr(
            Option.getOrUndefined(
              Arr.findFirst(db.staticContent, (row) => row.key === key)
            )
          )
        ),
      upsert: (key, html) =>
        Effect.sync(() => {
          const block: StaticContent = { html, key };
          db.staticContent = [
            ...Arr.filter(db.staticContent, (row) => row.key !== key),
            block,
          ];

          return block;
        }),
    });

    const sponsors = SponsorRepository.of({
      create: (draft) =>
        Effect.sync(() => {
          const sponsor: Sponsor = { ...draft, id: SponsorId.make(takeId()) };
          db.sponsors.push(sponsor);

          return sponsor;
        }),
      list: Effect.sync(() => [...db.sponsors]),
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
        Effect.sync(() =>
          Arr.map(messages, (message) => {
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
        ),
    });

    const auditLog = AuditLog.of({
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

    const delivery = OutboxDelivery.of({
      claimDue: ({ limit, ids }) =>
        Effect.map(DateTime.now, (now) =>
          Arr.map(
            Arr.filter(
              db.outbox,
              (row) =>
                row.status === "pending" &&
                row.claimToken === null &&
                (row.nextAttemptAt === null ||
                  !DateTime.isGreaterThan(row.nextAttemptAt, now)) &&
                (ids === undefined || ids.includes(row.id))
            ).slice(0, limit),
            (row): ClaimedOutboxMessage => {
              row.attempts += 1;
              row.claimToken = OutboxClaimToken.make(`claim-${takeId()}`);

              return {
                attempts: row.attempts,
                claimToken: row.claimToken,
                createdAt: now,
                id: row.id,
                message: row.message,
              };
            }
          )
        ),
      markDelivered: (id, claimToken) =>
        updateClaim(id, claimToken, (row) => {
          row.status = "delivered";
          row.claimToken = null;
        }),
      markFailed: (id, claimToken, error, next) =>
        updateClaim(id, claimToken, (row) => {
          row.claimToken = null;
          row.lastError = error;

          if (next === "dead") {
            row.status = "dead";
          } else {
            row.nextAttemptAt = next;
          }
        }),
    });

    const admissionPeriods = AdmissionPeriodRepository.of({
      list: Effect.sync(() => db.admissionPeriods),
    });

    return Context.make(DepartmentRepository, departments).pipe(
      Context.add(AdmissionPeriodRepository, admissionPeriods),
      Context.add(SemesterRepository, semesters),
      Context.add(FieldOfStudyRepository, fieldsOfStudy),
      Context.add(ArticleRepository, articles),
      Context.add(StaticContentRepository, staticContent),
      Context.add(SponsorRepository, sponsors),
      Context.add(SocialEventRepository, socialEvents),
      Context.add(PublicFileRepository, publicFiles),
      Context.add(FileStore, fileStore),
      Context.add(Outbox, outbox),
      Context.add(AuditLog, auditLog),
      Context.add(OutboxDelivery, delivery)
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
        Effect.suspend(() => {
          const before: Omit<MemoryTables, "commits" | "nextId"> = {
            admissionPeriods: [...db.admissionPeriods],
            articles: [...db.articles],
            audit: [...db.audit],
            departments: [...db.departments],
            fieldsOfStudy: [...db.fieldsOfStudy],
            objects: new Map(db.objects),
            outbox: Arr.map(db.outbox, (row) => ({ ...row })),
            publicFiles: [...db.publicFiles],
            semesters: [...db.semesters],
            socialEvents: [...db.socialEvents],
            sponsors: [...db.sponsors],
            staticContent: [...db.staticContent],
          };

          return Effect.provideService(program, InTransaction, {
            kind: "database-transaction",
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                db.commits += 1;
              })
            ),
            Effect.onError(() =>
              Effect.sync(() => {
                Object.assign(db, before);
              })
            )
          );
        }),
    });
  })
);

/** Every in-memory service over `tables` (fresh by default), acting as `actor` (anonymous by default). */
export const memoryLayer = (
  tables: MemoryTables = makeTables(),
  actor: Actor = anonymous
) =>
  Layer.mergeAll(
    repositories,
    transactor,
    Layer.succeed(CurrentActor, actor)
  ).pipe(Layer.provideMerge(Layer.succeed(Memory, tables)));

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

export const fakeArticle = (
  id: number,
  options: {
    readonly published: boolean;
    readonly createdAt: DateTime.Utc;
    readonly departmentIds?: readonly number[];
  }
): Article => ({
  authorId: null,
  body: sanitizeRichText(`<p>Tekst ${id}</p>`),
  createdAt: options.createdAt,
  departmentIds: Arr.map(options.departmentIds ?? [], (value) =>
    DepartmentId.make(value)
  ),
  id: ArticleId.make(id),
  imageLargeKey: fakeKey(id + 10_000),
  imageSmallKey: fakeKey(id),
  published: options.published,
  slug: Slug.make(`nyhet-${id}`),
  sticky: false,
  title: `Nyhet ${id}`,
});
