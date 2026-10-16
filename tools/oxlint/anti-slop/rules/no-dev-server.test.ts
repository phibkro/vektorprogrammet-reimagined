// Run with `node --test`: the Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";

import { RuleTester } from "vite-plus/lint/plugins-dev";

import { noDevServerRule } from "./no-dev-server.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const devServer = (command: string) => [
  { messageId: "devServer", data: { command } },
];

new RuleTester().run("no-dev-server", noDevServerRule, {
  valid: [
    // Negative controls: builds, the production servers, and Vite's preview of a build.
    'runCommand("bun", ["run", "build"], { cwd: dashboardRoot })',
    'startProcess("bun", ["server.mjs"], { cwd: dashboardRoot })',
    'spawn("node", ["node_modules/@react-router/serve/dist/cli.js", "build/server/index.js"])',
    'start("bunx", ["vite", "preview", "--host", "127.0.0.1", "--port", String(port)])',
    'const webServer = { command: "bun --no-env-file run build && bun --no-env-file server.mjs" }',
    'const command = "bun run --cwd apps/homepage worker:build && bun run --cwd apps/homepage worker:dev"',
    'run("bun", ["run", "dev:content"])',
    // "dev" and the CLI names outside a command.
    'import { defineConfig } from "vite"',
    'const condition = "development"',
    'const labels = ["dev", "vite"]',
    'join(root, "node_modules/@react-router/dev/dist/cli/index.js")',
  ],
  invalid: [
    // The hosted failure: the dashboard Playwright webServer ran the dev script.
    {
      code: 'const dashboardServer = { command: "bun run dev --host 127.0.0.1 --port 5174" }',
      errors: devServer("run dev"),
    },
    {
      code: 'startProcess("node", ["node_modules/@react-router/dev/dist/cli/index.js", "dev", "--port", String(port)])',
      errors: devServer("node_modules/@react-router/dev/dist/cli/index.js dev"),
    },
    {
      code: 'spawn("vite", ["dev", "--port", String(port)])',
      errors: devServer("vite dev"),
    },
    {
      code: 'Bun.spawn(["bunx", "vite", "serve"])',
      errors: devServer("vite serve"),
    },
    {
      code: "const command = `react-router dev --port ${port}`",
      errors: devServer("react-router dev"),
    },
    {
      code: 'run("bun", ["run", "--cwd", "apps/dashboard", "run", "dev"])',
      errors: devServer("run dev"),
    },
  ],
});
