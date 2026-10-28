/**
 * A SELECT-only role on the disposable database (spec 0003, falsifier 3: "reads never write").
 *
 * `readOnlyRole` needs `TestDatabaseUrl` (`disposableDatabase.ts`) and provides `ReadOnlyDatabaseUrl`: the URL
 * of a login role that may connect and `SELECT` from every table, and nothing else: no INSERT, UPDATE,
 * DELETE or TRUNCATE, no sequence use, no temporary tables, no `CREATE`. Code that runs through it and
 * succeeds therefore wrote nothing. A write is refused with `permission denied` (SQLSTATE 42501), which
 * `DatabaseLive` turns into a defect.
 *
 * The role is cluster-wide; `restrictedRole.ts` drops what it owns and then the role itself before the database is
 * dropped. It needs a `TEST_DATABASE_ADMIN_URL` role that may create roles (devenv's is a superuser).
 */
import { assert } from "@effect/vitest";
import type { Redacted } from "effect";
import { Cause, Context, Exit, Layer } from "effect";

import { restrictedRole } from "./restrictedRole.ts";

/** The URL of a role on the disposable database that holds SELECT and nothing else. */
export class ReadOnlyDatabaseUrl extends Context.Service<
  ReadOnlyDatabaseUrl,
  Redacted.Redacted
>()("test/ReadOnlyDatabaseUrl") {}

export const readOnlyRole = Layer.effect(
  ReadOnlyDatabaseUrl,
  restrictedRole(
    "vp_read_only_",
    (role) => `grant select on all tables in schema public to "${role}"`
  )
);

/** Asserts that `exit` is the refusal of a write by the role: a failure whose cause says `permission denied`. */
export const assertPermissionDenied = (exit: Exit.Exit<unknown, unknown>) => {
  assert.isTrue(Exit.isFailure(exit));

  if (Exit.isFailure(exit)) {
    assert.include(Cause.pretty(exit.cause), "permission denied");
  }
};
