import {
  COLLECTIONS,
  CmsClient,
  CmsInvalidContent,
  CmsRejected,
  CmsUnavailable,
  ContentEditor,
  CreateOutcome,
} from "@vektorprogrammet/cms-client";
import type {
  Collection,
  CollectionName,
  Entry,
} from "@vektorprogrammet/cms-client";
import {
  Array as Arr,
  DateTime,
  Effect,
  Layer,
  Record as Rec,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

const invalid = (
  collection: string,
  slug: string | null,
  error: Schema.SchemaError
) => new CmsInvalidContent({ collection, message: error.message, slug });

const unavailable =
  (operation: string) => (error: { readonly message: string }) =>
    new CmsUnavailable({ operation, reason: error.message });

const date = Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString);

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const encodeDraft = (
  collection: CollectionName,
  slug: string,
  input: Schema.Json
) =>
  Schema.decodeEffect(Schema.toCodecJson(COLLECTIONS[collection]))(input).pipe(
    Effect.flatMap(json),
    Effect.mapError((error) => invalid(collection, slug, error))
  );

const ContentRow = Schema.Struct({
  collection: Schema.Literals(Rec.keys(COLLECTIONS)),
  createdAt: Schema.String,
  draft: Schema.Json,
  published: Schema.NullOr(Schema.Json),
  publishedAt: Schema.NullOr(Schema.String),
  slug: Schema.String,
});

interface PublishedRow {
  readonly id: string;
  readonly slug: string;
  readonly data: unknown;
  readonly created_at: string;
  readonly published_at: string;
}

export const ContentLive = Layer.mergeAll(
  Layer.effect(
    CmsClient,
    Effect.gen(function* buildPublishedContent() {
      const sql = yield* SqlClient;

      const collection = <A, I>(
        name: CollectionName,
        schema: Schema.Codec<A, I>
      ): Collection<A> => {
        const codec = Schema.toCodecJson(schema);

        const decode = Effect.fnUntraced(function* decodePublishedRow(
          row: PublishedRow
        ) {
          const mapError = (error: Schema.SchemaError) =>
            invalid(name, row.slug, error);

          return {
            createdAt: yield* date(row.created_at).pipe(
              Effect.mapError(mapError)
            ),
            data: yield* Schema.decodeUnknownEffect(codec)(row.data).pipe(
              Effect.mapError(mapError)
            ),
            id: row.id,
            publishedAt: yield* date(row.published_at).pipe(
              Effect.mapError(mapError)
            ),
            slug: row.slug,
          } satisfies Entry<A>;
        });

        const published =
          sql<PublishedRow>`select id, slug, published as data, created_at::text, published_at::text from site_content where collection = ${name} and published is not null`.pipe(
            Effect.mapError(unavailable("published")),
            Effect.flatMap((rows) => Effect.forEach(rows, decode))
          );

        return {
          create: Effect.fnUntraced(function* createImportedEntry(entry) {
            const data = yield* Schema.encodeEffect(codec)(entry.data).pipe(
              Effect.flatMap(json),
              Effect.mapError((error) => invalid(name, entry.slug, error))
            );

            const rows = yield* sql<{
              readonly id: string;
            }>`insert into site_content (collection, slug, draft, created_at, draft_published_at) values (${name}, ${entry.slug}, ${data}::jsonb, ${DateTime.formatIso(entry.createdAt)}::timestamptz, ${DateTime.formatIso(entry.publishedAt)}::timestamptz) on conflict (collection, slug) do nothing returning id`.pipe(
              Effect.mapError(unavailable("create"))
            );

            return rows[0] === undefined
              ? CreateOutcome.SlugTaken()
              : CreateOutcome.Created({ id: rows[0].id });
          }),
          listings: sql<{
            readonly id: string;
            readonly slug: string;
            readonly status: string;
          }>`select id, slug, case when published is null then 'draft' else 'published' end as status from site_content where collection = ${name}`.pipe(
            Effect.mapError(unavailable("listings"))
          ),
          publish: (id) =>
            sql`update site_content set published = draft, published_at = coalesce(draft_published_at, now()) where collection = ${name} and id = ${id}::uuid`.pipe(
              Effect.mapError(unavailable("publish")),
              Effect.asVoid
            ),
          published,
          publishedBySlug: (slug) =>
            published.pipe(
              Effect.map((entries) =>
                Arr.findFirst(entries, (entry) => entry.slug === slug)
              )
            ),
        };
      };

      return CmsClient.of({
        faq: collection("faq", COLLECTIONS.faq),
        news: collection("news", COLLECTIONS.news),
        sponsors: collection("sponsors", COLLECTIONS.sponsors),
        teams: collection("teams", COLLECTIONS.teams),
        texts: collection("texts", COLLECTIONS.texts),
      });
    })
  ),
  Layer.effect(
    ContentEditor,
    Effect.gen(function* buildContentEditor() {
      const sql = yield* SqlClient;

      return ContentEditor.of({
        create: Effect.fnUntraced(function* createDraft(
          collection: CollectionName,
          slug: string,
          input: Schema.Json
        ) {
          const data = yield* encodeDraft(collection, slug, input);

          const rows = yield* sql<{
            readonly id: string;
          }>`insert into site_content (collection, slug, draft) values (${collection}, ${slug}, ${data}::jsonb) on conflict (collection, slug) do nothing returning id`.pipe(
            Effect.mapError(unavailable("create"))
          );

          if (rows.length === 0) {
            return yield* new CmsRejected({
              code: "SLUG_CONFLICT",
              message: "Content already exists",
              operation: "create",
              status: 409,
            });
          }

          return yield* Effect.void;
        }),
        list: sql`select collection, slug, draft, published, created_at::text as "createdAt", published_at::text as "publishedAt" from site_content order by collection, slug`.pipe(
          Effect.mapError(unavailable("list")),
          Effect.flatMap((rows) =>
            Schema.decodeUnknownEffect(Schema.Array(ContentRow))(rows).pipe(
              Effect.mapError((error) => invalid("site_content", null, error))
            )
          )
        ),
        publish: Effect.fnUntraced(function* publishDraft(collection, slug) {
          const rows = yield* sql<{
            readonly id: string;
          }>`update site_content set published = draft, published_at = coalesce(published_at, draft_published_at, now()) where collection = ${collection} and slug = ${slug} returning id`.pipe(
            Effect.mapError(unavailable("publish"))
          );

          if (rows.length === 0) {
            return yield* new CmsRejected({
              code: "NOT_FOUND",
              message: "Content not found",
              operation: "publish",
              status: 404,
            });
          }

          return yield* Effect.void;
        }),
        save: Effect.fnUntraced(function* saveDraft(collection, slug, input) {
          const data = yield* encodeDraft(collection, slug, input);

          const rows = yield* sql<{
            readonly id: string;
          }>`update site_content set draft = ${data}::jsonb where collection = ${collection} and slug = ${slug} returning id`.pipe(
            Effect.mapError(unavailable("save"))
          );

          if (rows.length === 0) {
            return yield* new CmsRejected({
              code: "NOT_FOUND",
              message: "Content not found",
              operation: "save",
              status: 404,
            });
          }

          return yield* Effect.void;
        }),
      });
    })
  )
);
