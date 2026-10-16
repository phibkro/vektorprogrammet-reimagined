import { NodeServices } from "@effect/platform-node";

/** Node-backed services shared by the CLI and real-database integration tests. */
export const nodeServicesLayer = NodeServices.layer;
