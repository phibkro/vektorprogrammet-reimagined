/**
 * Effect's `Crypto.Crypto` over Web Crypto (`globalThis.crypto`), which both
 * workerd and Node provide. The domain's `storeUpload` uses it for SHA-256
 * content-addressed keys.
 */
import { Crypto, Effect, Layer } from "effect";

export const webCrypto: Crypto.Crypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(() => globalThis.crypto.subtle.digest(algorithm, data.slice())).pipe(
      Effect.map((digest) => new Uint8Array(digest)),
    ),
});

export const webCryptoLayer: Layer.Layer<Crypto.Crypto> = Layer.succeed(Crypto.Crypto, webCrypto);
