import { PgClient } from "@effect/sql-pg";
import { getTableName, is, Table } from "drizzle-orm";
import { Array as Arr, Effect, Record as Rec } from "effect";
import type { Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlClient as SqlClientType } from "effect/sql/SqlClient";

import { createAuthViews } from "./authViews.ts";
import * as schema from "./schema.ts";

const exports: readonly unknown[] = Rec.values(schema);

const tables = Arr.map(
  Arr.filter(exports, (value): value is Table => is(value, Table)),
  getTableName
);

const ensureRole = (sql: SqlClientType, role: string, password: string) =>
  Effect.gen(function* ensureRoleEffect() {
    if (
      !/^vektor_runtime(?:_[a-z0-9]+)?$/u.test(role) ||
      !/^[a-f0-9]{64}$/u.test(password)
    ) {
      return yield* Effect.die("Invalid runtime role or credential");
    }

    const existing =
      yield* sql`select rolname from pg_roles where rolname = ${role}`;

    if (existing.length === 0) {
      yield* sql.unsafe(
        `create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit`
      );
    } else {
      const safe =
        yield* sql`select 1 from pg_roles r where r.rolname = ${role} and r.rolcanlogin and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication and not r.rolbypassrls and not r.rolinherit and not exists (select 1 from pg_auth_members m where m.member = r.oid) and not exists (select 1 from pg_class c where c.relowner = r.oid) and not exists (select 1 from pg_namespace n where n.nspowner = r.oid)`;

      if (safe.length !== 1) {
        return yield* Effect.die("Existing runtime role is not restricted");
      }
    }

    return yield* Effect.void;
  });

const grantTables = (sql: SqlClientType, role: string) =>
  Effect.gen(function* grantTablesEffect() {
    for (const table of tables) {
      const name = `"${table.replaceAll('"', '""')}"`;
      yield* sql.unsafe(`revoke all on public.${name} from ${role}, public`);
      yield* sql.unsafe(
        `do $$ declare r record; begin for r in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop execute format('revoke all on public.%I from %I', '${table.replaceAll("'", "''")}', r.rolname); end loop; end $$`
      );
      yield* sql.unsafe(
        `grant select, insert, update, delete on public.${name} to ${role}`
      );
      yield* sql.unsafe(`alter table public.${name} enable row level security`);
      yield* sql.unsafe(
        `drop policy if exists vektor_runtime_server on public.${name}`
      );
      yield* sql.unsafe(
        `create policy vektor_runtime_server on public.${name} to ${role} using (true) with check (true)`
      );
    }

    const literals = Arr.join(
      Arr.map(tables, (name) => `'${name.replaceAll("'", "''")}'`),
      ", "
    );

    yield* sql.unsafe(
      `do $sequences$ declare s record; begin for s in select distinct ns.nspname, seq.relname from pg_class seq join pg_namespace ns on ns.oid = seq.relnamespace join pg_depend d on d.objid = seq.oid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i') join pg_class tbl on tbl.oid = d.refobjid join pg_namespace tn on tn.oid = tbl.relnamespace where seq.relkind = 'S' and tn.nspname = 'public' and tbl.relname in (${literals}) loop execute format('grant usage on sequence %I.%I to %I', s.nspname, s.relname, '${role}'); end loop; end $sequences$`
    );
  });

/** Apply grants only after migrations using bootstrap authority, never from a Worker. */
export const provisionRuntimeAccess = (
  adminUrl: Redacted.Redacted,
  password: string,
  role = "vektor_runtime"
) =>
  Effect.gen(function* provisionAccessEffect() {
    const sql = yield* SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* applyAccess() {
        yield* ensureRole(sql, role, password);
        yield* createAuthViews(sql);
        yield* sql.unsafe(
          `grant usage on schema public, vektor_private to ${role}`
        );
        yield* sql.unsafe(
          `do $$ declare r record; begin for r in select rolname from pg_roles where rolcanlogin and rolname <> '${role}' and has_database_privilege(oid, current_database(), 'TEMPORARY') loop execute format('grant temporary on database %I to %I', current_database(), r.rolname); end loop; execute format('revoke temporary on database %I from public', current_database()); end $$`
        );
        yield* grantTables(sql, role);
        yield* sql.unsafe(
          `revoke all on vektor_private.users, vektor_private.identities, vektor_private.sessions from ${role}, public`
        );
        yield* sql.unsafe(
          `do $$ declare r record; begin for r in select rolname from pg_roles where rolname in ('anon', 'authenticated') loop execute format('revoke all on vektor_private.users, vektor_private.identities, vektor_private.sessions from %I', r.rolname); end loop; end $$`
        );
        yield* sql.unsafe(
          `grant select on vektor_private.users, vektor_private.identities, vektor_private.sessions to ${role}`
        );
      })
    );
  }).pipe(Effect.provide(PgClient.layer({ maxConnections: 1, url: adminUrl })));

export const runtimeRoleExists = (url: Redacted.Redacted) =>
  Effect.gen(function* findRuntimeRole() {
    const sql = yield* SqlClient;

    const rows =
      yield* sql`select 1 from pg_roles where rolname = 'vektor_runtime'`;

    return rows.length > 0;
  }).pipe(Effect.provide(PgClient.layer({ maxConnections: 1, url })));

export const probeRuntimeLogin = (url: Redacted.Redacted) =>
  Effect.gen(function* probeLogin() {
    const sql = yield* SqlClient;
    yield* sql`select current_user`;
  }).pipe(Effect.provide(PgClient.layer({ maxConnections: 1, url })));
