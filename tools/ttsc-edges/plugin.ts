import type { ITtscPluginFactoryContext } from "ttsc";

/** The descriptor of the spike's check plugin: the Go sources in `plugin/` are built by ttsc's bundled toolchain. */
export const createTtscPlugin = (context: ITtscPluginFactoryContext) => ({
  hostInputHashes: {},
  name: "ttsc-edges",
  source: `${context.dirname}/plugin`,
  stage: "check" as const,
});
