import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

/**
 * The platform services of the tests that run domain code over real PostgreSQL. `NodeServices` carries no crypto
 * service since Effect 4.1, and the codes (`mintCode`, `hashCode`) need a digest and random bytes.
 */
export const nodeCryptoServices = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layerDigest,
  NodeCrypto.layerSecureRandom
);
