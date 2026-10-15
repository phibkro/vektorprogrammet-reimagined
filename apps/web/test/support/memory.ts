/**
 * In-memory Layers for apps/web tests (Node, `vp test`). Real database
 * behaviour is `packages/db`'s job; these fakes implement the domain's
 * service contracts just far enough for the web runtime, routes and outbox
 * delivery to be exercised. Every value is a fake same-shape value.
 */
import { OutboxClaimToken, OutboxDelivery, type ClaimedOutboxMessage } from "@vektorprogrammet/db";
import {
  AlreadyExists,
  ArticleId,
  ArticleRepository,
  AuditLog,
  CurrentActor,
  DepartmentId,
  DepartmentRepository,
  EmailAddress,
  FileKey,
  FileStore,
  InTransaction,
  NotFound,
  Outbox,
  OutboxMessageId,
  PublicFileRepository,
  SanitizedHtmlFromString,
  Slug,
  StaticContentRepository,
  anonymous,
  type Article,
  type AuditEntry,
  type Department,
  type OutboxMessage,
  type PublicFile,
  type StaticContent,
} from "@vektorprogrammet/domain";
import { Context, DateTime, Effect, Layer, Option, Schema, Stream } from "effect";
import { Transactor } from "../../src/server/transactor";

export interface OutboxRow {
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
  departments: Array<Department>;
  articles: Array<Article>;
  staticContent: Array<StaticContent>;
  publicFiles: Array<PublicFile>;
  objects: Map<string, Uint8Array>;
  outbox: Array<OutboxRow>;
  audit: Array<AuditEntry>;
  /** Number of `Transactor.run` calls that committed. */
  commits: number;
}

export class Memory extends Context.Service<Memory, MemoryTables>()("test/Memory") {}

/** Fresh tables; tests keep the reference to inspect what was (not) written. */
export const makeTables = (seed: Partial<MemoryTables> = {}): MemoryTables => ({
  departments: [],
  articles: [],
  staticContent: [],
  publicFiles: [],
  objects: new Map(),
  outbox: [],
  audit: [],
  commits: 0,
  ...seed,
});

const repositories = Layer.effectContext(
  Effect.gen(function* () {
    const db = yield* Memory;
    let nextId = 1;

    const departments = DepartmentRepository.of({
      list: Effect.sync(() => db.departments),
      findById: (id) =>
        Effect.suspend(() => {
          const found = db.departments.find((row) => row.id === id);
          return found === undefined
            ? Effect.fail(new NotFound({ entity: "Department", key: String(id) }))
            : Effect.succeed(found);
        }),
      create: (draft) =>
        Effect.suspend(() => {
          if (db.departments.some((row) => row.city === draft.city)) {
            return Effect.fail(
              new AlreadyExists({
                entity: "Department",
                key: draft.city,
                message: "Byen finnes allerede.",
              }),
            );
          }
          const created: Department = { id: DepartmentId.make(nextId++), ...draft };
          db.departments.push(created);
          return Effect.succeed(created);
        }),
      update: (id, draft) =>
        Effect.suspend(() => {
          const index = db.departments.findIndex((row) => row.id === id);
          if (index < 0)
            return Effect.fail(new NotFound({ entity: "Department", key: String(id) }));
          const updated: Department = { id, ...draft };
          db.departments[index] = updated;
          return Effect.succeed(updated);
        }),
    });

    const articles = ArticleRepository.of({
      create: (draft) =>
        Effect.suspend(() => {
          if (db.articles.some((row) => row.slug === draft.slug)) {
            return Effect.fail(
              new AlreadyExists({ entity: "Article", key: draft.slug, message: "Slug finnes." }),
            );
          }
          const created: Article = { id: ArticleId.make(nextId++), ...draft };
          db.articles.push(created);
          return Effect.succeed(created);
        }),
      findById: (id) =>
        Effect.suspend(() => {
          const found = db.articles.find((row) => row.id === id);
          return found === undefined
            ? Effect.fail(new NotFound({ entity: "Article", key: String(id) }))
            : Effect.succeed(found);
        }),
      findBySlug: (slug) =>
        Effect.sync(() => Option.fromNullishOr(db.articles.find((row) => row.slug === slug))),
      slugsLike: (base) =>
        Effect.sync(() =>
          db.articles
            .map((row) => row.slug)
            .filter((slug) => slug === base || slug.startsWith(`${base}-`)),
        ),
      listPublished: Effect.sync(() => db.articles.filter((row) => row.published)),
      setPublished: (id, published) =>
        Effect.suspend(() => {
          const index = db.articles.findIndex((row) => row.id === id);
          if (index < 0) return Effect.fail(new NotFound({ entity: "Article", key: String(id) }));
          const updated: Article = { ...db.articles[index]!, published };
          db.articles[index] = updated;
          return Effect.succeed(updated);
        }),
    });

    const staticContent = StaticContentRepository.of({
      find: (key) =>
        Effect.sync(() => Option.fromNullishOr(db.staticContent.find((row) => row.key === key))),
      upsert: (key, html) =>
        Effect.sync(() => {
          const block: StaticContent = { key, html };
          db.staticContent = [...db.staticContent.filter((row) => row.key !== key), block];
          return block;
        }),
    });

    const publicFiles = PublicFileRepository.of({
      findByKey: (key) =>
        Effect.sync(() => Option.fromNullishOr(db.publicFiles.find((row) => row.key === key))),
      findByLegacyPath: (legacyPath) =>
        Effect.sync(() =>
          Option.fromNullishOr(db.publicFiles.find((row) => row.legacyPath === legacyPath)),
        ),
      register: (file) =>
        Effect.sync(() => {
          const existing = db.publicFiles.find((row) => row.key === file.key);
          if (existing !== undefined) return existing;
          db.publicFiles.push(file);
          return file;
        }),
    });

    const fileStore = FileStore.of({
      put: ({ key, bytes }) =>
        Effect.sync(() => {
          db.objects.set(key, bytes);
        }),
      get: (key) =>
        Effect.sync(() =>
          Option.map(Option.fromNullishOr(db.objects.get(key)), (bytes) => ({
            size: bytes.byteLength,
            body: Stream.make(bytes),
          })),
        ),
    });

    const outbox = Outbox.of({
      enqueue: (messages) =>
        Effect.sync(() =>
          messages.map((message) => {
            const id = OutboxMessageId.make(`outbox-${nextId++}`);
            db.outbox.push({
              id,
              message,
              attempts: 0,
              status: "pending",
              claimToken: null,
              nextAttemptAt: null,
              lastError: null,
            });
            return id;
          }),
        ),
    });

    const auditLog = AuditLog.of({
      record: (entry) =>
        Effect.sync(() => {
          db.audit.push(entry);
        }),
    });

    const delivery = OutboxDelivery.of({
      claimDue: ({ limit, ids }) =>
        Effect.map(DateTime.now, (now) =>
          db.outbox
            .filter(
              (row) =>
                row.status === "pending" &&
                row.claimToken === null &&
                (row.nextAttemptAt === null || !DateTime.isGreaterThan(row.nextAttemptAt, now)) &&
                (ids === undefined || ids.includes(row.id)),
            )
            .slice(0, limit)
            .map((row): ClaimedOutboxMessage => {
              row.attempts += 1;
              row.claimToken = OutboxClaimToken.make(`claim-${nextId++}`);
              return {
                id: row.id,
                claimToken: row.claimToken,
                attempts: row.attempts,
                message: row.message,
                createdAt: now,
              };
            }),
        ),
      markDelivered: (id, claimToken) =>
        Effect.sync(() => {
          const row = db.outbox.find((candidate) => candidate.id === id);
          if (row === undefined || row.claimToken !== claimToken) return "claimLost" as const;
          row.status = "delivered";
          row.claimToken = null;
          return "recorded" as const;
        }),
      markFailed: (id, claimToken, error, next) =>
        Effect.sync(() => {
          const row = db.outbox.find((candidate) => candidate.id === id);
          if (row === undefined || row.claimToken !== claimToken) return "claimLost" as const;
          row.claimToken = null;
          row.lastError = error;
          if (next === "dead") row.status = "dead";
          else row.nextAttemptAt = next;
          return "recorded" as const;
        }),
    });

    return Context.make(DepartmentRepository, departments).pipe(
      Context.add(ArticleRepository, articles),
      Context.add(StaticContentRepository, staticContent),
      Context.add(PublicFileRepository, publicFiles),
      Context.add(FileStore, fileStore),
      Context.add(Outbox, outbox),
      Context.add(AuditLog, auditLog),
      Context.add(OutboxDelivery, delivery),
    );
  }),
);

/**
 * Test `Transactor`: provides `InTransaction` and snapshots the tables, so a
 * failed command leaves nothing behind (what `SqlClient.withTransaction` does
 * for real).
 */
const transactor = Layer.effect(
  Transactor,
  Effect.gen(function* () {
    const db = yield* Memory;
    return Transactor.of({
      run: (program) =>
        Effect.suspend(() => {
          const before: Omit<MemoryTables, "commits"> = {
            departments: [...db.departments],
            articles: [...db.articles],
            staticContent: [...db.staticContent],
            publicFiles: [...db.publicFiles],
            objects: new Map(db.objects),
            outbox: db.outbox.map((row) => ({ ...row })),
            audit: [...db.audit],
          };
          return Effect.provideService(program, InTransaction, {
            kind: "database-transaction",
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                db.commits += 1;
              }),
            ),
            Effect.onError(() =>
              Effect.sync(() => {
                Object.assign(db, before);
              }),
            ),
          );
        }),
    });
  }),
);

/** Every in-memory service over `tables` (fresh by default), with an anonymous actor. */
export const memoryLayer = (tables: MemoryTables = makeTables()) =>
  Layer.mergeAll(repositories, transactor, Layer.succeed(CurrentActor, anonymous)).pipe(
    Layer.provideMerge(Layer.succeed(Memory, tables)),
  );

// ---------------------------------------------------------------- fake fixtures

export const fakeDepartment = (
  id: number,
  city: string,
  overrides: Partial<Department> = {},
): Department => ({
  id: DepartmentId.make(id),
  name: `Vektor ${city}`,
  shortName: city.slice(0, 4).toUpperCase(),
  email: EmailAddress.make(`${city.toLowerCase()}@example.org`),
  city,
  address: null,
  active: true,
  slackChannel: null,
  logoKey: null,
  latitude: null,
  longitude: null,
  ...overrides,
});

const decodeHtml = Schema.decodeSync(SanitizedHtmlFromString);
export const fakeKey = (
  seed: number,
  extension: "png" | "jpg" | "bin" | "pdf" | "gif" | "webp" = "png",
) => FileKey.make(`${seed.toString(16).padStart(64, "0")}.${extension}`);

export const fakeArticle = (
  id: number,
  options: {
    readonly published: boolean;
    readonly createdAt: DateTime.Utc;
    readonly departmentIds?: ReadonlyArray<number>;
  },
): Article => ({
  id: ArticleId.make(id),
  title: `Nyhet ${id}`,
  slug: Slug.make(`nyhet-${id}`),
  body: decodeHtml(`<p>Tekst ${id}</p>`),
  imageSmallKey: fakeKey(id),
  imageLargeKey: fakeKey(id + 10_000),
  sticky: false,
  published: options.published,
  departmentIds: (options.departmentIds ?? []).map((value) => DepartmentId.make(value)),
  authorId: null,
  createdAt: options.createdAt,
});
