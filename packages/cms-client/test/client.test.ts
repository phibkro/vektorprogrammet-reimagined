import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Redacted,
} from "effect";
import type { Schema } from "effect";
import { Headers, HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { CmsClient, CreateOutcome, layer } from "../src/index.ts";

const BASE = "https://cms.test";

const TOKEN = "ec_pat_secret";

type Status = "draft" | "published";

/** A content item as EmDash lists it (every field of its `ContentItem`; the values are fake). */
const item = (
  slug: string,
  data: Readonly<Record<string, Schema.Json>>,
  status: Status = "published"
) => ({
  authorId: "01AUTHOR",
  byline: null,
  bylines: [],
  createdAt: "2024-01-15T11:00:00.000Z",
  data,
  draftRevisionId: null,
  id: `01ID${slug}`,
  liveRevisionId: "01REV",
  locale: "en",
  primaryBylineId: null,
  publishedAt: "2024-01-16T08:30:00.000Z",
  scheduledAt: null,
  slug,
  status,
  translationGroup: `01ID${slug}`,
  type: "news",
  updatedAt: "2024-01-17T09:00:00.000Z",
  version: 2,
});

const listing = (items: readonly unknown[], nextCursor?: string) =>
  Response.json({
    data: nextCursor === undefined ? { items } : { items, nextCursor },
    success: true,
  });

const single = (found: ReturnType<typeof item>) =>
  Response.json({ data: { _rev: "r", item: found }, success: true });

const failure = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message }, success: false }, { status });

interface Sent {
  readonly authorization: Option.Option<string>;
  readonly body: string;
  readonly method: string;
  readonly url: URL;
}

/** A CmsClient over an `HttpClient` that answers every request with `handler`'s Response and records what was sent. */
const fakeCms = (handler: (url: URL) => Response) => {
  const sent: Sent[] = [];

  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      sent.push({
        authorization: Headers.get(request.headers, "authorization"),
        body: Predicate.isTagged(request.body, "Uint8Array")
          ? new TextDecoder().decode(request.body.body)
          : "",
        method: request.method,
        url,
      });

      return Effect.succeed(HttpClientResponse.fromWeb(request, handler(url)));
    })
  );

  return {
    layer: layer({ token: Redacted.make(TOKEN), url: BASE }).pipe(
      Layer.provide(http)
    ),
    sent,
  };
};

const ARTICLE = {
  content: [],
  departments: ["Trondheim"],
  sticky: 1,
  title: "Opptak åpner",
};

describe("CmsClient reads", () => {
  it.effect(
    "follows the cursor to the last page and decodes each entry",
    () => {
      const cms = fakeCms((url) =>
        url.searchParams.get("cursor") === "next-1"
          ? listing([item("two", { title: "To" })])
          : listing([item("one", ARTICLE)], "next-1")
      );

      return Effect.gen(function* followsCursor() {
        const { news } = yield* CmsClient;
        const entries = yield* news.published;

        assert.deepStrictEqual(
          Arr.map(entries, (entry) => entry.slug),
          ["one", "two"]
        );
        assert.deepStrictEqual(
          Arr.map(cms.sent, ({ method, url }) => [
            method,
            url.origin + url.pathname,
            url.searchParams.get("status"),
            url.searchParams.get("cursor"),
          ]),
          [
            ["GET", `${BASE}/_emdash/api/content/news`, "published", null],
            ["GET", `${BASE}/_emdash/api/content/news`, "published", "next-1"],
          ]
        );
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect(
    "stops with CmsUnavailable when the CMS never ends its cursor",
    () => {
      const cms = fakeCms(() => listing([item("one", ARTICLE)], "again"));

      return Effect.gen(function* boundsPaging() {
        const { news } = yield* CmsClient;

        const reason = yield* news.published.pipe(
          Effect.catchTag("CmsUnavailable", (error) =>
            Effect.succeed(error.reason)
          )
        );

        assert.strictEqual(reason, "news has more than 200 pages");
        assert.strictEqual(cms.sent.length, 200);
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect(
    "reads EmDash's 0/1 booleans, optional fields and ISO dates into domain values",
    () => {
      const cms = fakeCms(() => listing([item("one", ARTICLE)]));

      return Effect.gen(function* decodesQuirks() {
        const { news } = yield* CmsClient;
        const [entry] = yield* news.published;

        assert.strictEqual(entry?.data.sticky, true);
        assert.deepStrictEqual(entry?.data.departments, ["Trondheim"]);
        assert.strictEqual(entry?.data.image, undefined);
        assert.strictEqual(
          DateTime.formatIso(entry?.publishedAt ?? DateTime.makeUnsafe(0)),
          "2024-01-16T08:30:00.000Z"
        );
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect(
    "sends the bearer token to the CMS base URL and nowhere else",
    () => {
      const cms = fakeCms(() => listing([]));

      return Effect.gen(function* sendsToken() {
        const { texts, sponsors } = yield* CmsClient;
        yield* texts.published;
        yield* sponsors.published;

        assert.deepStrictEqual(
          Arr.map(cms.sent, ({ authorization, url }) => [
            url.origin,
            authorization,
          ]),
          [
            [BASE, Option.some(`Bearer ${TOKEN}`)],
            [BASE, Option.some(`Bearer ${TOKEN}`)],
          ]
        );
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect(
    "drops an entry that is not published even when the CMS returns it (a token that can read drafts)",
    () => {
      const cms = fakeCms(() =>
        listing([item("live", ARTICLE), item("draft", ARTICLE, "draft")])
      );

      return Effect.gen(function* dropsDrafts() {
        const { news } = yield* CmsClient;

        assert.deepStrictEqual(
          Arr.map(yield* news.published, (entry) => entry.slug),
          ["live"]
        );
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect(
    "fails with the entry's slug when its data does not match the collection",
    () => {
      const cms = fakeCms(() => listing([item("broken", { sticky: "yes" })]));

      return Effect.gen(function* rejectsMalformed() {
        const { news } = yield* CmsClient;

        const slug = yield* news.published.pipe(
          Effect.catchTag("CmsInvalidContent", (error) =>
            Effect.succeed(error.slug)
          )
        );

        assert.strictEqual(slug, "broken");
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect(
    "a refused token is a CmsRejected with the CMS's code and status",
    () => {
      const cms = fakeCms(() =>
        failure(401, "NOT_AUTHENTICATED", "Not authenticated")
      );

      return Effect.gen(function* rejectsToken() {
        const { texts } = yield* CmsClient;

        const refusal = yield* texts.published.pipe(
          Effect.catchTag("CmsRejected", (error) =>
            Effect.succeed([error.status, error.code])
          )
        );

        assert.deepStrictEqual(refusal, [401, "NOT_AUTHENTICATED"]);
        assert.strictEqual(cms.sent.length, 1);
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect("retries a transient failure and then reads", () => {
    const answers = [503, 503, 200];

    const cms = fakeCms(() => {
      const status = answers.shift() ?? 200;

      return status === 200
        ? listing([item("one", ARTICLE)])
        : failure(status, "UNAVAILABLE", "try again");
    });

    return Effect.gen(function* retriesReads() {
      const { news } = yield* CmsClient;
      const fiber = yield* Effect.forkChild(news.published);
      yield* TestClock.adjust(Duration.seconds(2));
      const entries = yield* Fiber.join(fiber);

      assert.strictEqual(entries.length, 1);
      assert.strictEqual(cms.sent.length, 3);
    }).pipe(Effect.provide(cms.layer));
  });

  it.effect("gives up after two retries with CmsUnavailable", () => {
    const cms = fakeCms(() => failure(503, "UNAVAILABLE", "down"));

    return Effect.gen(function* givesUp() {
      const { news } = yield* CmsClient;

      const fiber = yield* Effect.forkChild(
        news.published.pipe(
          Effect.catchTag("CmsUnavailable", (error) =>
            Effect.succeed(error.status)
          )
        )
      );

      yield* TestClock.adjust(Duration.seconds(5));

      assert.strictEqual(yield* Fiber.join(fiber), 503);
      assert.strictEqual(cms.sent.length, 3);
    }).pipe(Effect.provide(cms.layer));
  });
});

describe("CmsClient single entries", () => {
  it.effect(
    "answers none for an unknown slug (404) and for an entry that is not published",
    () => {
      const cms = fakeCms((url) =>
        url.pathname.endsWith("/missing")
          ? failure(404, "NOT_FOUND", "Content item not found")
          : single(item("draft", ARTICLE, "draft"))
      );

      return Effect.gen(function* noneForDraftAndMissing() {
        const { news } = yield* CmsClient;

        assert.isTrue(Option.isNone(yield* news.publishedBySlug("missing")));
        assert.isTrue(Option.isNone(yield* news.publishedBySlug("draft")));
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect("reads a published entry by slug", () => {
    const cms = fakeCms(() => single(item("one", ARTICLE)));

    return Effect.gen(function* readsBySlug() {
      const { news } = yield* CmsClient;
      const found = yield* news.publishedBySlug("one");

      assert.strictEqual(
        Option.getOrUndefined(found)?.data.title,
        "Opptak åpner"
      );
      assert.strictEqual(
        cms.sent[0]?.url.pathname,
        "/_emdash/api/content/news/one"
      );
    }).pipe(Effect.provide(cms.layer));
  });
});

describe("CmsClient writes", () => {
  const entry = {
    createdAt: DateTime.makeUnsafe("2024-01-15T11:00:00.000Z"),
    data: { departments: ["Trondheim"], sticky: true, title: "Opptak åpner" },
    publishedAt: DateTime.makeUnsafe("2024-01-16T08:30:00.000Z"),
    slug: "opptak-apner",
  };

  it.effect(
    "creates a draft with the original dates and answers its id",
    () => {
      const cms = fakeCms(() =>
        Response.json(
          {
            data: { _rev: "r", item: item("opptak-apner", ARTICLE, "draft") },
            success: true,
          },
          { status: 201 }
        )
      );

      return Effect.gen(function* createsDraft() {
        const { news } = yield* CmsClient;
        const outcome = yield* news.create(entry);

        assert.deepStrictEqual(
          outcome,
          CreateOutcome.Created({ id: "01IDopptak-apner" })
        );
        assert.strictEqual(cms.sent[0]?.method, "POST");
        assert.strictEqual(
          cms.sent[0]?.url.pathname,
          "/_emdash/api/content/news"
        );
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect(
    "a taken slug (409 SLUG_CONFLICT) is SlugTaken, not a failure",
    () => {
      const cms = fakeCms(() =>
        failure(
          409,
          "SLUG_CONFLICT",
          "Slug 'opptak-apner' already exists in collection 'news'"
        )
      );

      return Effect.gen(function* slugTaken() {
        const { news } = yield* CmsClient;

        assert.deepStrictEqual(
          yield* news.create(entry),
          CreateOutcome.SlugTaken()
        );
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect(
    "a token without the write scope is a CmsRejected, and is not retried",
    () => {
      const cms = fakeCms(() =>
        failure(
          403,
          "INSUFFICIENT_SCOPE",
          "Token lacks required scope: content:write"
        )
      );

      return Effect.gen(function* refusesScope() {
        const { news } = yield* CmsClient;

        const code = yield* news
          .create(entry)
          .pipe(
            Effect.catchTag("CmsRejected", (error) =>
              Effect.succeed(error.code)
            )
          );

        assert.strictEqual(code, "INSUFFICIENT_SCOPE");
        assert.strictEqual(cms.sent.length, 1);
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect(
    "a server failure on a write is reported once, never replayed",
    () => {
      const cms = fakeCms(() => failure(503, "UNAVAILABLE", "down"));

      return Effect.gen(function* neverReplays() {
        const { news } = yield* CmsClient;

        const status = yield* news
          .create(entry)
          .pipe(
            Effect.catchTag("CmsUnavailable", (error) =>
              Effect.succeed(error.status)
            )
          );

        assert.strictEqual(status, 503);
        assert.strictEqual(cms.sent.length, 1);
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect("publishes by id", () => {
    const cms = fakeCms(() => single(item("opptak-apner", ARTICLE)));

    return Effect.gen(function* publishes() {
      const { news } = yield* CmsClient;
      yield* news.publish("01IDopptak-apner");

      assert.strictEqual(
        cms.sent[0]?.url.pathname,
        "/_emdash/api/content/news/01IDopptak-apner/publish"
      );
    }).pipe(Effect.provide(cms.layer));
  });
});

describe("CmsClient media", () => {
  it.effect("turns an entry's media path into an absolute CMS URL", () => {
    const cms = fakeCms(() => listing([]));

    return Effect.gen(function* absolutizes() {
      const cmsClient = yield* CmsClient;

      assert.strictEqual(
        cmsClient.absoluteUrl("/_emdash/api/media/file/01ABC.jpg"),
        `${BASE}/_emdash/api/media/file/01ABC.jpg`
      );
    }).pipe(Effect.provide(cms.layer));
  });
});

/** A select field as EmDash answers `GET …/fields/{field}`: every key of its `Field`; the values are fake. */
const field = (validation: Readonly<Record<string, Schema.Json>> | null) => ({
  collectionId: "01COLLECTION",
  createdAt: "2024-01-01T00:00:00.000Z",
  defaultValue: null,
  id: "01FIELD",
  indexed: false,
  label: "Avdelinger",
  options: null,
  required: false,
  searchable: false,
  slug: "departments",
  sortOrder: 2,
  translatable: false,
  type: "multiSelect",
  unique: false,
  updatedAt: "2024-01-01T00:00:00.000Z",
  validation,
  widget: null,
});

const fieldResponse = (
  validation: Readonly<Record<string, Schema.Json>> | null
) => Response.json({ data: { item: field(validation) }, success: true });

describe("CmsClient select options", () => {
  it.effect(
    "adds the options a select lacks, keeps the ones it has, and says how many were new",
    () => {
      const cms = fakeCms(() => fieldResponse({ options: ["Trondheim"] }));

      return Effect.gen(function* addsOptions() {
        const { ensureOptions } = yield* CmsClient;

        const added = yield* ensureOptions("news", "departments", [
          "Bergen",
          "Trondheim",
          "Bergen",
        ]);

        const [read, write] = cms.sent;

        assert.strictEqual(added, 1);
        assert.deepStrictEqual(
          [
            read?.method,
            read?.url.pathname,
            write?.method,
            write?.url.pathname,
          ],
          [
            "GET",
            "/_emdash/api/schema/collections/news/fields/departments",
            "PUT",
            "/_emdash/api/schema/collections/news/fields/departments",
          ]
        );
        assert.strictEqual(
          write?.body,
          '{"validation":{"options":["Trondheim","Bergen"]}}'
        );
      }).pipe(Effect.provide(cms.layer));
    }
  );

  it.effect("writes nothing when every value is an option already", () => {
    const cms = fakeCms(() =>
      fieldResponse({ options: ["Trondheim", "Bergen"] })
    );

    return Effect.gen(function* leavesOptions() {
      const { ensureOptions } = yield* CmsClient;
      const added = yield* ensureOptions("news", "departments", ["Bergen"]);

      assert.strictEqual(added, 0);
      assert.deepStrictEqual(
        Arr.map(cms.sent, ({ method }) => method),
        ["GET"]
      );
    }).pipe(Effect.provide(cms.layer));
  });

  it.effect("treats a field with no validation as having no options", () => {
    const cms = fakeCms(() => fieldResponse(null));

    return Effect.gen(function* startsOptions() {
      const { ensureOptions } = yield* CmsClient;

      assert.strictEqual(
        yield* ensureOptions("teams", "department", ["Ås"]),
        1
      );
      assert.strictEqual(
        cms.sent[1]?.body,
        '{"validation":{"options":["Ås"]}}'
      );
    }).pipe(Effect.provide(cms.layer));
  });
});
