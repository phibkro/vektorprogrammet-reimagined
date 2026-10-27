import { Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { nodeServicesLayer } from "../support/nodeServices.ts";
import { world } from "../support/world.ts";

/** What every runtime test needs: the disposable database and the real model on it, files and processes, HTTP. */
export const base = Layer.mergeAll(
  world,
  nodeServicesLayer,
  FetchHttpClient.layer
);
