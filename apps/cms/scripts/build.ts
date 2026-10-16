/**
 * Builds the CMS exactly as Alchemy's `Cloudflare.Website.Astro` does (`alchemy.run.ts`): Astro's programmatic
 * build with Alchemy's wrangler-free Cloudflare adapter, over this project's own `astro.config.ts`. Nothing is
 * deployed. `bun run ready` runs it, so a change that only builds under `@astrojs/cloudflare` fails here.
 */
import * as Astro from "@alchemy.run/frontend-frameworks/astro";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";

const root = new URL("..", import.meta.url).pathname;

const program = Effect.gen(function* program() {
  const framework = yield* Astro.make({ root });
  const output = yield* framework.build({ root });

  yield* Console.log(
    `built: ${output.serverModules?.length ?? 0} server modules, client directory ${output.clientDirectory}`
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
