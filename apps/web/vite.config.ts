import { availableParallelism } from "node:os";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { Config, Effect, Option } from "effect";
import { defineConfig } from "vite-plus";

import {
  COMPATIBILITY_DATE,
  COMPATIBILITY_FLAGS,
  CONTACT_RATE_LIMIT,
  CRON_TRIGGERS,
  TURNSTILE_TEST_KEYS,
  WORKER_MAIN,
} from "./worker.config";

const environment = Effect.runSync(
  Config.all({
    database: Config.String("DATABASE_URL").pipe(Config.withDefault("")),
    domainTests: Config.option(Config.String("DOMAIN_TESTS")),
    publishableKey: Config.String("SUPABASE_PUBLISHABLE_KEY").pipe(
      Config.withDefault("")
    ),
    secretKey: Config.String("SUPABASE_SECRET_KEY").pipe(
      Config.withDefault("")
    ),
    site: Config.String("SITE_URL").pipe(
      Config.withDefault("http://localhost:3000")
    ),
    testing: Config.option(Config.String("VITEST")),
    url: Config.String("SUPABASE_URL").pipe(Config.withDefault("")),
  })
);

// Terraform supplies deployed secrets. Standalone production builds contain no credentials.
const standaloneWorker = (dev: boolean) =>
  cloudflare({
    config: {
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: COMPATIBILITY_FLAGS,
      main: WORKER_MAIN,
      name: "vektorprogrammet-web",
      ratelimits: [
        {
          name: "CONTACT_RATE_LIMIT",
          namespace_id: String(CONTACT_RATE_LIMIT.namespaceId),
          simple: {
            limit: CONTACT_RATE_LIMIT.limit,
            period: CONTACT_RATE_LIMIT.period,
          },
        },
      ],
      triggers: { crons: [...CRON_TRIGGERS] },
      vars: {
        DATABASE_URL: dev ? environment.database : "",
        DEPLOYMENT: dev ? "local" : "preview",
        SITE_URL: environment.site,
        SUPABASE_PUBLISHABLE_KEY: environment.publishableKey,
        SUPABASE_SECRET_KEY: dev ? environment.secretKey : "",
        SUPABASE_URL: environment.url,
        TURNSTILE_SECRET_KEY: dev ? TURNSTILE_TEST_KEYS.secretKey : "",
        TURNSTILE_SITE_KEY: TURNSTILE_TEST_KEYS.siteKey,
      },
    },
    viteEnvironment: { name: "ssr" },
  });

const LAZY_ROUTE_DEPENDENCIES = [
  "@base-ui/react/accordion",
  "@base-ui/react/button",
  "@base-ui/react/dialog",
  "@base-ui/react/input",
  "@base-ui/react/merge-props",
  "@base-ui/react/select",
  "@base-ui/react/separator",
  "@base-ui/react/switch",
  "@base-ui/react/tooltip",
  "@base-ui/react/use-render",
  "@icons-pack/react-simple-icons",
  "@marsidev/react-turnstile",
  "@portabletext/react",
  "@supabase/ssr",
  "@supabase/supabase-js",
  "class-variance-authority",
  "clsx",
  "lucide-react",
  "tailwind-merge",
];

export default defineConfig(({ command }) => ({
  environments: { ssr: { optimizeDeps: { include: LAZY_ROUTE_DEPENDENCIES } } },
  optimizeDeps: { include: LAZY_ROUTE_DEPENDENCIES },
  plugins: Option.isSome(environment.testing)
    ? []
    : [
        standaloneWorker(command === "serve"),
        tailwindcss(),
        tanstackStart(),
        viteReact(),
      ],
  resolve: { tsconfigPaths: true },
  test: {
    hookTimeout: 60_000,
    include: ["test/**/*.test.{ts,tsx}"],
    maxWorkers: Option.isSome(environment.domainTests)
      ? Math.max(availableParallelism() - 1, 1)
      : Math.min(2, Math.max(availableParallelism() - 1, 1)),
    testTimeout: 60_000,
  },
}));
