/**
 * The CMS as the public site and the importer see it: typed reads of published content and the two writes the
 * importer needs (create, publish), over the client generated from EmDash's OpenAPI document.
 *
 * - Every request goes to one base URL with one bearer token (`CmsConfig`); nothing else carries the token.
 * - A read asks for `status=published` and keeps only entries that say they are published. A token created by an
 *   administrator can read drafts, so the server's answer is not trusted to have filtered them.
 * - Entry data is decoded once, with the collection's schema (`collections.ts`); a malformed entry is a
 *   `CmsInvalidContent`, never half-rendered content.
 * - Reads are idempotent and retried on transient failures (transport errors, 5xx, 429); writes are not.
 */
import {
  Array as Arr,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Schedule,
  Schema,
} from "effect";
import type { Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientError } from "effect/http";

import { COLLECTIONS } from "./collections.ts";
import type {
  FaqData,
  NewsData,
  SponsorData,
  TeamData,
  TextData,
} from "./collections.ts";
import * as Generated from "./generated.ts";

export interface CmsConfig {
  /** The CMS origin, e.g. `https://cms.example.org`. Public: media URLs derive from it. */
  readonly url: string;
  readonly token: Redacted.Redacted;
}

/** The CMS is unreachable, slow, or answered with a failure the caller cannot act on. */
export class CmsUnavailable extends Schema.TaggedError<
  CmsUnavailable,
  { readonly brand: unique symbol }
>()("CmsUnavailable", {
  operation: Schema.String,
  reason: Schema.String,
  status: Schema.optionalKey(Schema.Int),
}) {}

/** The CMS refused the request (4xx): the token lacks a scope, the body is invalid, the slug is taken. */
export class CmsRejected extends Schema.TaggedError<
  CmsRejected,
  { readonly brand: unique symbol }
>()("CmsRejected", {
  code: Schema.String,
  message: Schema.String,
  operation: Schema.String,
  status: Schema.Int,
}) {}

/** An entry's data does not match its collection's schema. */
export class CmsInvalidContent extends Schema.TaggedError<
  CmsInvalidContent,
  { readonly brand: unique symbol }
>()("CmsInvalidContent", {
  collection: Schema.String,
  message: Schema.String,
  slug: Schema.NullOr(Schema.String),
}) {}

export type CmsFailure = CmsUnavailable | CmsRejected | CmsInvalidContent;

/** A published entry: its decoded data and the dates EmDash keeps for it. */
export interface Entry<A> {
  readonly id: string;
  readonly slug: string | null;
  readonly data: A;
  readonly createdAt: DateTime.Utc;
  readonly publishedAt: DateTime.Utc | null;
}

/** An entry as the CMS lists it, whatever its status; data stays undecoded (the importer counts by status). */
export interface Listing {
  readonly id: string;
  readonly slug: string | null;
  readonly status: string;
}

/** What the importer writes: a slug, the collection's data and the original dates. */
export interface NewEntry<A> {
  readonly slug: string;
  readonly data: A;
  readonly createdAt: DateTime.Utc;
  readonly publishedAt: DateTime.Utc;
}

/** `Created` carries the new draft's id; `SlugTaken` means an entry with that slug exists and nothing changed. */
export type CreateOutcome = Data.TaggedEnum<{
  Created: { readonly id: string };
  SlugTaken: object;
}>;

export const CreateOutcome = Data.taggedEnum<CreateOutcome>();

/** One collection's operations. */
export interface Collection<A> {
  /** Every published entry, in the CMS's order, decoded. */
  readonly published: Effect.Effect<readonly Entry<A>[], CmsFailure>;
  /** The published entry with `slug`, or none. */
  readonly publishedBySlug: (
    slug: string
  ) => Effect.Effect<Option.Option<Entry<A>>, CmsFailure>;
  /** Every entry whatever its status, undecoded. */
  readonly listings: Effect.Effect<readonly Listing[], CmsFailure>;
  /** Creates a draft; a slug that is taken answers `SlugTaken`. */
  readonly create: (
    entry: NewEntry<A>
  ) => Effect.Effect<CreateOutcome, CmsFailure>;
  readonly publish: (id: string) => Effect.Effect<void, CmsFailure>;
}

export class CmsClient extends Context.Service<
  CmsClient,
  {
    readonly texts: Collection<TextData>;
    readonly news: Collection<NewsData>;
    readonly sponsors: Collection<SponsorData>;
    readonly faq: Collection<FaqData>;
    readonly teams: Collection<TeamData>;
    /** A media path from an entry (`/_emdash/api/media/file/…`) as an absolute URL on the CMS. */
    readonly absoluteUrl: (path: string) => string;
  }
>()("@vektorprogrammet/cms-client/CmsClient") {}

/** EmDash's error envelope: `{ success: false, error: { code, message } }`. */
const ApiError = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});

/** The envelope as an object (a status the OpenAPI document declares) or as the JSON text of an undeclared one. */
const decodeApiError = Schema.decodeUnknownOption(
  Schema.Union([ApiError, Schema.fromJsonString(ApiError)])
);

/** What the generated client fails with: a transport or status failure, a body that does not match, or a declared status. */
type GeneratedFailure =
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | Generated.EmDashError<string, unknown>;

const statusOf = (error: GeneratedFailure): number | undefined =>
  Predicate.hasProperty(error, "response") &&
  Predicate.hasProperty(error.response, "status") &&
  Predicate.isNumber(error.response.status)
    ? error.response.status
    : undefined;

const envelopeOf = (error: GeneratedFailure) => {
  if (Predicate.hasProperty(error, "cause")) {
    return decodeApiError(error.cause);
  }

  return Predicate.hasProperty(error, "reason") &&
    Predicate.hasProperty(error.reason, "description")
    ? decodeApiError(error.reason.description)
    : Option.none();
};

/** The one place that turns the generated client's failures into the three the callers know. */
const failureOf = (
  operation: string,
  error: GeneratedFailure
): CmsUnavailable | CmsRejected => {
  const status = statusOf(error);
  const envelope = envelopeOf(error);

  if (status !== undefined && status < 500 && Option.isSome(envelope)) {
    return new CmsRejected({
      code: envelope.value.error.code,
      message: envelope.value.error.message,
      operation,
      status,
    });
  }

  const reason =
    Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
      ? error.message
      : "the CMS did not answer as expected";

  return status === undefined
    ? new CmsUnavailable({ operation, reason })
    : new CmsUnavailable({ operation, reason, status });
};

const READ_TIMEOUT = Duration.seconds(8);

const PAGE_SIZE = 100;

/** A collection longer than this many pages is a CMS that does not end its cursor, not content. */
const MAX_PAGES = 200;

const decodeDate = Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString);

const JsonRecord = Schema.Record(Schema.String, Schema.Json);

const publishedOnly = (items: readonly Generated.ContentItem[]) =>
  Arr.filter(items, (item) => item.status === "published");

export const layer = (
  config: CmsConfig
): Layer.Layer<CmsClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    CmsClient,
    Effect.gen(function* cmsClientLayer() {
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          HttpClientRequest.bearerToken(
            HttpClientRequest.acceptJson(
              HttpClientRequest.prependUrl(request, config.url)
            ),
            config.token
          )
        )
      );

      const reads = Generated.make(
        http.pipe(
          HttpClient.retryTransient({
            schedule: Schedule.exponential(Duration.millis(150)),
            times: 2,
          })
        )
      );

      const writes = Generated.make(http);

      const listPage = Effect.fn("CmsClient.listPage")(function* listPage(
        collection: string,
        status: "published" | "all",
        cursor: string | undefined
      ) {
        const response = yield* reads
          .listContent(collection, {
            params:
              cursor === undefined
                ? { limit: PAGE_SIZE, status }
                : { cursor, limit: PAGE_SIZE, status },
          })
          .pipe(
            Effect.timeout(READ_TIMEOUT),
            Effect.mapError((error) =>
              Predicate.isTagged(error, "TimeoutError")
                ? new CmsUnavailable({
                    operation: "listContent",
                    reason: `no answer within ${Duration.toMillis(READ_TIMEOUT)} ms`,
                  })
                : failureOf("listContent", error)
            )
          );

        return response.data;
      });

      const allItems = (
        collection: string,
        status: "published" | "all"
      ): Effect.Effect<readonly Generated.ContentItem[], CmsFailure> => {
        const from = (
          pagesRead: number,
          cursor?: string
        ): Effect.Effect<readonly Generated.ContentItem[], CmsFailure> =>
          pagesRead >= MAX_PAGES
            ? Effect.fail(
                new CmsUnavailable({
                  operation: "listContent",
                  reason: `${collection} has more than ${MAX_PAGES} pages`,
                })
              )
            : Effect.flatMap(listPage(collection, status, cursor), (page) =>
                page.nextCursor === undefined
                  ? Effect.succeed(page.items)
                  : Effect.map(from(pagesRead + 1, page.nextCursor), (rest) => [
                      ...page.items,
                      ...rest,
                    ])
              );

        return from(0);
      };

      const collectionOf = <A, I>(
        name: string,
        schema: Schema.Codec<A, I>
      ): Collection<A> => {
        const codec = Schema.toCodecJson(schema);
        const decodeData = Schema.decodeUnknownEffect(codec);
        const encodeData = Schema.encodeEffect(codec);

        const decodeEntry = Effect.fnUntraced(function* decodeEntry(
          item: Generated.ContentItem
        ) {
          const invalid = (error: Schema.SchemaError) =>
            new CmsInvalidContent({
              collection: name,
              message: error.message,
              slug: item.slug,
            });

          const data = yield* decodeData(item.data).pipe(
            Effect.mapError(invalid)
          );

          const publishedAt =
            item.publishedAt === null
              ? null
              : yield* decodeDate(item.publishedAt).pipe(
                  Effect.mapError(invalid)
                );

          return {
            createdAt: yield* decodeDate(item.createdAt).pipe(
              Effect.mapError(invalid)
            ),
            data,
            id: item.id,
            publishedAt,
            slug: item.slug,
          } satisfies Entry<A>;
        });

        return {
          create: Effect.fn("CmsClient.create")(function* create(entry) {
            const invalid = (error: Schema.SchemaError) =>
              new CmsInvalidContent({
                collection: name,
                message: error.message,
                slug: entry.slug,
              });

            const data = yield* encodeData(entry.data).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(JsonRecord)),
              Effect.mapError(invalid)
            );

            return yield* writes
              .createContent(name, {
                payload: {
                  createdAt: DateTime.formatIso(entry.createdAt),
                  data,
                  publishedAt: DateTime.formatIso(entry.publishedAt),
                  slug: entry.slug,
                },
              })
              .pipe(
                Effect.map((response) =>
                  CreateOutcome.Created({ id: response.data.item.id })
                ),
                Effect.mapError((error) => failureOf("createContent", error)),
                Effect.catchTag("CmsRejected", (rejected) =>
                  rejected.code === "SLUG_CONFLICT"
                    ? Effect.succeed(CreateOutcome.SlugTaken())
                    : Effect.fail(rejected)
                )
              );
          }),
          listings: allItems(name, "all").pipe(
            Effect.map(
              Arr.map((item): Listing => ({
                id: item.id,
                slug: item.slug,
                status: item.status,
              }))
            )
          ),
          publish: Effect.fn("CmsClient.publish")(function* publish(id) {
            yield* writes
              .publishContent(name, id, { payload: {} })
              .pipe(
                Effect.mapError((error) => failureOf("publishContent", error))
              );
          }),
          published: allItems(name, "published").pipe(
            Effect.flatMap((items) =>
              Effect.forEach(publishedOnly(items), decodeEntry)
            )
          ),
          publishedBySlug: Effect.fn("CmsClient.publishedBySlug")(
            function* publishedBySlug(slug) {
              const found = yield* reads.getContent(name, slug, {}).pipe(
                Effect.asSome,
                Effect.catch((error) =>
                  statusOf(error) === 404
                    ? Effect.succeedNone
                    : Effect.fail(failureOf("getContent", error))
                )
              );

              const [item] = Option.match(found, {
                onNone: () => [],
                onSome: (response) => publishedOnly([response.data.item]),
              });

              return item === undefined
                ? Option.none()
                : Option.some(yield* decodeEntry(item));
            }
          ),
        };
      };

      return CmsClient.of({
        absoluteUrl: (path) => new URL(path, config.url).toString(),
        faq: collectionOf("faq", COLLECTIONS.faq),
        news: collectionOf("news", COLLECTIONS.news),
        sponsors: collectionOf("sponsors", COLLECTIONS.sponsors),
        teams: collectionOf("teams", COLLECTIONS.teams),
        texts: collectionOf("texts", COLLECTIONS.texts),
      });
    })
  );
