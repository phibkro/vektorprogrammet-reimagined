/** Test-only Worker using the same startup check and bindings module as the deployed entry. */
import { env } from "cloudflare:workers";

import { validateAuthStartup } from "../../src/server/authStartup";

validateAuthStartup(env.BETTER_AUTH_SECRET);

export default {
  fetch: () => new Response("ready"),
};
