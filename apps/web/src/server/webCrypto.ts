/**
 * The crypto services the domain needs, over Web Crypto (`globalThis.crypto`), which both workerd and Node
 * provide. `storeUpload` and the codes use `Digest` (SHA-256), and `mintCode` and the Workspace nonce use
 * `SecureRandom`.
 */
import { Layer } from "effect";
import { Digest, SecureRandom } from "effect/crypto";

export const webCryptoLayer: Layer.Layer<
  Digest.Digest | SecureRandom.SecureRandom
> = Layer.mergeAll(Digest.layerWebCrypto, SecureRandom.layerWebCrypto);
