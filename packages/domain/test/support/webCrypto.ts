/**
 * Web Crypto from the test runtime (Workers provide the same API), for the commands that hash a code. The one
 * definition for this package's tests and for the database tests (`@vektorprogrammet/domain/testing/crypto`).
 */
import { Crypto, Effect, Layer } from "effect";

export const WebCryptoTest = Layer.succeed(Crypto.Crypto)(
  Crypto.make({
    digest: (algorithm, data) =>
      Effect.map(
        Effect.promise(
          globalThis.crypto.subtle.digest.bind(
            globalThis.crypto.subtle,
            algorithm,
            new Uint8Array(data)
          )
        ),
        (buffer) => new Uint8Array(buffer)
      ),
    randomBytes: (size) =>
      globalThis.crypto.getRandomValues(new Uint8Array(size)),
  })
);
