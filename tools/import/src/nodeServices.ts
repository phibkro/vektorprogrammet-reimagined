import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

/**
 * Node-backed services shared by the CLI and real-database integration tests. `NodeServices` carries no crypto
 * service since Effect 4.1, so the SHA-256 of the legacy files and the tests' random names come from `NodeCrypto`.
 */
export const nodeServicesLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layerDigest,
  NodeCrypto.layerSecureRandom
);
