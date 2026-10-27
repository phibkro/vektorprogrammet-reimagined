import { NodeServices } from "@effect/platform-node";

/** Node-backed FileSystem, Path and ChildProcessSpawner, for the tests that read engine files and own processes. */
export const nodeServicesLayer = NodeServices.layer;
