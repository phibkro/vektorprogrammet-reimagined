import { Effect, Redacted, Schema } from "effect";
import { Mac } from "effect/crypto";

export const runtimePassword = Effect.fnUntraced(function* runtimePassword(
  seed: Redacted.Redacted,
  repository: string,
  branchRef: string
) {
  const mac = yield* Mac.Mac;
  const encoder = new TextEncoder();

  const key = yield* Mac.key(
    Mac.hmacSha256,
    encoder.encode(Redacted.value(seed))
  );

  const signature = yield* mac.sign(
    key,
    encoder.encode(`vektor-preview-runtime\0${repository}\0${branchRef}`)
  );

  return Redacted.make(
    yield* Schema.encodeEffect(Schema.Uint8ArrayFromHex)(signature)
  );
});
