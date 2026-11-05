import { Config, Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { PreviewError } from "./config.ts";
import type { PreviewIdentity } from "./config.ts";

const PullRequest = Schema.Struct({
  head: Schema.Struct({ sha: Schema.String }),
  state: Schema.Literals(["open", "closed"]),
});

/** GitHub is authoritative even when both preview resources are already absent. */
export const assertTeardownAuthority = Effect.fnUntraced(
  function* assertTeardownAuthority(identity: PreviewIdentity) {
    const token = yield* Config.Redacted("GH_TOKEN").pipe(
      Effect.mapError(
        () => new PreviewError({ message: "Missing GitHub token" })
      )
    );

    if (!Redacted.value(token)) {
      return yield* new PreviewError({ message: "Missing GitHub token" });
    }

    const client = yield* HttpClient.HttpClient;

    const request = HttpClientRequest.get(
      `https://api.github.com/repos/${identity.repository}/pulls/${identity.pullRequest}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${Redacted.value(token)}`,
          "user-agent": "vektor-preview-teardown",
        },
      }
    );

    const response = yield* client
      .execute(request)
      .pipe(
        Effect.mapError(
          () => new PreviewError({ message: "GitHub authority request failed" })
        )
      );

    if (response.status !== 200) {
      return yield* new PreviewError({
        message: "GitHub authority request failed",
      });
    }

    const pull = yield* HttpClientResponse.schemaBodyJson(PullRequest)(
      response
    ).pipe(
      Effect.mapError(
        () => new PreviewError({ message: "Invalid GitHub authority response" })
      )
    );

    if (pull.state !== "closed" || pull.head.sha !== identity.headSha) {
      return yield* new PreviewError({
        message: "Refusing stale preview teardown",
      });
    }

    return yield* Effect.void;
  }
);
