/**
 * What an editor does in the CMS, through its REST API with the token the harness minted (`E2E_CMS_URL`,
 * `E2E_CMS_TOKEN`): read a text, save a change to it (EmDash keeps that as a draft of a published entry), and
 * publish it. The specs use it to show that an edit published in the CMS reaches the public pages without a
 * deploy (falsifier 2). `runCms` is the one place an Effect becomes the Promise the Playwright runner awaits.
 */
import { Config, Effect, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

const environment = Config.all({
  origin: Config.String("E2E_CMS_URL"),
  token: Config.Redacted("E2E_CMS_TOKEN"),
});

/** A text's data as EmDash keeps it: a title and Portable Text blocks. */
const TextData = Schema.Record(Schema.String, Schema.Json);

const TextAnswer = Schema.Struct({
  data: Schema.Struct({
    item: Schema.Struct({ data: TextData, status: Schema.String }),
  }),
});

const textClient = Effect.gen(function* textClient() {
  const { origin, token } = yield* environment;
  const http = yield* HttpClient.HttpClient;

  return HttpClient.filterStatusOk(http).pipe(
    HttpClient.mapRequest((request) =>
      HttpClientRequest.bearerToken(
        HttpClientRequest.prependUrl(
          request,
          `${origin}/_emdash/api/content/texts`
        ),
        Redacted.value(token)
      )
    )
  );
});

/** The text with `slug`, as the CMS shows it to an editor (the saved draft, if there is one). */
export const readText = Effect.fn("readText")(function* readText(slug: string) {
  const http = yield* textClient;
  const response = yield* http.execute(HttpClientRequest.get(`/${slug}`));

  const { data } =
    yield* HttpClientResponse.schemaBodyJson(TextAnswer)(response);

  return data.item;
});

/** Saves `data` as the text's new content: on a published text it is a draft until `publishText`. */
export const saveText = Effect.fn("saveText")(function* saveText(
  slug: string,
  data: typeof TextData.Type
) {
  const http = yield* textClient;

  return yield* http.execute(
    HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.put(`/${slug}`), {
      data,
    })
  );
});

export const publishText = Effect.fn("publishText")(function* publishText(
  slug: string
) {
  const http = yield* textClient;

  return yield* http.execute(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(`/${slug}/publish`),
      {}
    )
  );
});

/** Portable Text of one plain paragraph. */
export const paragraph = (text: string): Schema.Json => [
  {
    _key: "e2e-block",
    _type: "block",
    children: [{ _key: "e2e-span", _type: "span", marks: [], text }],
    markDefs: [],
    style: "normal",
  },
];

export const runCms = async <A, E>(
  program: Effect.Effect<A, E, HttpClient.HttpClient>
): Promise<A> =>
  await Effect.runPromise(
    program.pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie)
  );
