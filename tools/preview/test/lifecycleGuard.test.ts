import { assert, it } from "@effect/vitest";
import type { Schema } from "effect";
import { ConfigProvider, Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { PreviewIdentity } from "../config.ts";
import { assertTeardownAuthority } from "../lifecycleGuard.ts";

const identity: PreviewIdentity = {
  branchName: "vektorprogrammet-pr-42",
  headSha: "a".repeat(40),
  parentProjectRef: "b".repeat(20),
  pullRequest: 42,
  repository: "phibkro/vektorprogrammet-reimagined",
  siteUrl: "https://vektorprogrammet-pr-42.synthetic.workers.dev",
  workerName: "vektorprogrammet-pr-42",
};

const authority = (body: Schema.Json, status = 200) => {
  const client = HttpClient.make((request, url) => {
    assert.strictEqual(request.method, "GET");
    assert.strictEqual(url.hostname, "api.github.com");
    assert.strictEqual(url.pathname, `/repos/${identity.repository}/pulls/42`);

    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json(body, { status }))
    );
  });

  return assertTeardownAuthority(identity).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ GH_TOKEN: "test-token" })
    )
  );
};

it.effect("authorizes only a closed pull request at the event head", () =>
  Effect.gen(function* testAuthority() {
    yield* authority({ head: { sha: identity.headSha }, state: "closed" });

    for (const [state, sha] of [
      ["open", identity.headSha],
      ["closed", "c".repeat(40)],
      ["open", "c".repeat(40)],
    ] as const) {
      const error = yield* Effect.flip(authority({ head: { sha }, state }));
      assert.strictEqual(error.message, "Refusing stale preview teardown");
    }
  })
);

it.effect(
  "fails closed on non-success and undecodable GitHub responses without exposing request data",
  () =>
    Effect.gen(function* testResponse() {
      for (const check of [
        authority({ message: "test-token" }, 403),
        authority({ head: {}, state: "closed" }),
      ]) {
        const error = yield* Effect.flip(check);
        assert.isFalse(error.message.includes("test-token"));
        assert.isFalse(error.message.includes("https://"));
      }
    })
);
