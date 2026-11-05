import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

/** Node-backed services shared by the CLI and real-database integration tests. */
export const nodeServicesLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layerDigest,
  NodeCrypto.layerSecureRandom
);
