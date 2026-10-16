/**
 * The smoke command's HTTP seam: one request per call, the answer decoded with the
 * contract schema, and every refusal (transport error, non-2xx answer, undecodable body,
 * timeout) as one tagged failure whose text becomes the failing line's evidence.
 * Nothing here retries: a failing check is reported, never retried until green.
 */
import {
  Array as Arr,
  Context,
  Duration,
  Effect,
  Layer,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { ErrorBody } from "../protocol.ts";
import { describeRefusal } from "../verdicts.ts";
import { RequestRefused } from "./refused.ts";

export type Params = Readonly<Record<string, string>>;

/** Longest a single request may take; a cold Neon compute needs seconds, a hung request needs a verdict. */
const REQUEST_TIMEOUT = Duration.seconds(60);

/** Longest the smoke command waits for the first line of the streaming `abort` route. */
const FIRST_LINE_TIMEOUT = Duration.seconds(30);

/** What a non-2xx answer said: the Worker's JSON error body, or the platform's own page. */
const refusalOf = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.flatMap(response.text, (text) =>
    Schema.decodeEffect(Schema.fromJsonString(ErrorBody))(text).pipe(
      Effect.map((body) => `${body.error.kind}: ${body.error.message}`),
      Effect.orElseSucceed(() => text),
      Effect.map((message) => describeRefusal(response.status, message))
    )
  );

export class SpikeClient extends Context.Service<
  SpikeClient,
  {
    readonly get: <A>(
      path: string,
      params: Params,
      schema: Schema.Codec<A>
    ) => Effect.Effect<A, RequestRefused>;
    readonly post: <A>(
      path: string,
      params: Params,
      schema: Schema.Codec<A>
    ) => Effect.Effect<A, RequestRefused>;
    /** Starts the streaming POST, returns its first text, then drops the request: the client abort. */
    readonly postUntilFirstText: (
      path: string,
      params: Params
    ) => Effect.Effect<string, RequestRefused>;
  }
>()("@vektorprogrammet/db-path-spike/SpikeClient") {
  static readonly layer = (baseUrl: string) =>
    Layer.effect(
      SpikeClient,
      Effect.gen(function* spikeClient() {
        const http = (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl))
        );

        const send = <A>(
          request: HttpClientRequest.HttpClientRequest,
          schema: Schema.Codec<A>
        ) =>
          http.execute(request).pipe(
            Effect.filterOrElse(
              (response) => response.status >= 200 && response.status < 300,
              (response) =>
                Effect.flatMap(refusalOf(response), (message) =>
                  Effect.fail(new RequestRefused({ message }))
                )
            ),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.mapError(
              (error) => new RequestRefused({ message: error.message })
            )
          );

        return SpikeClient.of({
          get: (path, params, schema) =>
            send(HttpClientRequest.get(path, { urlParams: params }), schema),
          post: (path, params, schema) =>
            send(HttpClientRequest.post(path, { urlParams: params }), schema),
          postUntilFirstText: (path, params) =>
            http
              .execute(
                HttpClientRequest.post(path, {
                  headers: { "accept-encoding": "identity" },
                  urlParams: params,
                })
              )
              .pipe(
                Effect.flatMap((response) =>
                  response.stream.pipe(
                    Stream.decodeText(),
                    Stream.take(1),
                    Stream.runCollect
                  )
                ),
                Effect.map((chunks) => Arr.join(chunks, "")),
                Effect.timeout(FIRST_LINE_TIMEOUT),
                Effect.mapError(
                  (error) => new RequestRefused({ message: error.message })
                )
              ),
        });
      })
    );
}
