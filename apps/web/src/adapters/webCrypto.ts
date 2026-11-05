/** Native Effect Web Crypto services for Workers and Node. */
import { Layer } from "effect";
import { Digest, SecureRandom } from "effect/crypto";

export const webCryptoLayer = Layer.merge(
  Digest.layerWebCrypto,
  SecureRandom.layerWebCrypto
);
