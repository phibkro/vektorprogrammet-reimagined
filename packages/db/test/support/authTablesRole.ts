/**
 * A login role on the disposable database that holds privileges on Better Auth's four tables and on nothing else (spec
 * 0017, falsifier 6: the Better Auth pool reads no domain table).
 *
 * `authTablesRole` needs `TestDatabaseUrl` (`disposableDatabase.ts`) and provides `AuthTablesDatabaseUrl`: the URL of a
 * role that may connect, and `SELECT`, `INSERT`, `UPDATE` and `DELETE` on `auth_user`, `auth_session`, `auth_account` and
 * `auth_verification`. A statement of Better Auth's own `pg` pool that reads `person`, `account` or any other table of
 * the domain is refused with `permission denied` (SQLSTATE 42501). Code that signs people in through this role and
 * succeeds therefore reads the domain only through the application's ports.
 *
 * The role is cluster-wide; `restrictedRole.ts` drops what it owns and then the role itself before the database is dropped.
 */
import type { Redacted } from "effect";
import { Array as Arr, Context, Layer } from "effect";

import { restrictedRole } from "./restrictedRole.ts";

/** Better Auth's tables (`modelName` in `apps/web/src/server/auth.ts`), the only ones that its pool may touch. */
export const AUTH_TABLES = [
  "auth_user",
  "auth_session",
  "auth_account",
  "auth_verification",
] as const;

/** The URL of a role on the disposable database that holds privileges on `AUTH_TABLES` and on no other table. */
export class AuthTablesDatabaseUrl extends Context.Service<
  AuthTablesDatabaseUrl,
  Redacted.Redacted
>()("test/AuthTablesDatabaseUrl") {}

export const authTablesRole = Layer.effect(
  AuthTablesDatabaseUrl,
  restrictedRole(
    "vp_auth_tables_",
    (role) =>
      `grant select, insert, update, delete on ${Arr.join(
        Arr.map(AUTH_TABLES, (table) => `"${table}"`),
        ", "
      )} to "${role}"`
  )
);
