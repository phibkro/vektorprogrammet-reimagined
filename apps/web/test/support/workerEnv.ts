import type {
  Hyperdrive,
  R2Bucket,
  RateLimit,
} from "@cloudflare/workers-types";

import type { WorkerEnv } from "../../src/server/env";

/** A binding that a test does not use: touching it fails the test instead of answering something. */
const unused = (): never => {
  throw new Error("this binding is not used by the test");
};

const hyperdrive = (connectionString: string): Hyperdrive => ({
  connect: unused,
  connectionString,
  database: "unused",
  host: "unused",
  ip: "unused",
  password: "unused",
  port: 0,
  user: "unused",
});

const publicFiles: R2Bucket = {
  createMultipartUpload: unused,
  delete: unused,
  get: unused,
  head: unused,
  list: unused,
  put: unused,
  resumeMultipartUpload: unused,
};

const contactRateLimit: RateLimit = {
  limit: async () => await Promise.resolve({ success: true }),
};

/** The Worker's bindings for a local deployment: the database is `connectionString`, every other binding answers nothing. */
export const workerEnv = (connectionString: string): WorkerEnv => ({
  BETTER_AUTH_SECRET: "local-fake-signing-secret-only-123456789",
  CMS_TOKEN: "local-fake-cms-token",
  CMS_URL: "http://127.0.0.1:1",
  CONTACT_RATE_LIMIT: contactRateLimit,
  DEPLOYMENT: "local",
  HYPERDRIVE: hyperdrive(connectionString),
  PUBLIC_FILES: publicFiles,
  SITE_URL: "https://scope.example",
  TURNSTILE_SECRET_KEY: "local-fake-turnstile-secret",
  TURNSTILE_SITE_KEY: "local-fake-turnstile-site",
});
