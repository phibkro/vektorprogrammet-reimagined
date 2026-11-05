/** Web Crypto services shared by domain and database tests. */
import { Layer } from "effect";
import { Digest, SecureRandom } from "effect/crypto";

export const WebCryptoTest = Layer.merge(
  Digest.layerWebCrypto,
  SecureRandom.layerWebCrypto
);
