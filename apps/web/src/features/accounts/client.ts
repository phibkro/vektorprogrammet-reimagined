/** Same-origin Worker endpoints; credentials and session cookies stay with Supabase SSR. */
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export const authRequest = (path: string, body: Record<string, string> = {}) =>
  Effect.runPromise(
    Effect.gen(function* sendAuthRequest() {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk
      );

      const request = yield* HttpClientRequest.post(
        new URL(`/api/auth/${path}`, window.location.origin).href
      ).pipe(HttpClientRequest.bodyJson(body));

      yield* client.execute(request);
    }).pipe(Effect.provide(FetchHttpClient.layer))
  );
