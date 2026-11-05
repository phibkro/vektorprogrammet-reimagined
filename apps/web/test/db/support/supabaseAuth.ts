/** Minimal provider-owned schema for disposable PostgreSQL tests, not a GoTrue emulator. */
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { createAuthViews } from "../../../src/adapters/db/authViews.ts";

/** A deterministic synthetic UUID, unique for each fixture person in its disposable database. */
export const providerUserId = (personId: number): string =>
  `00000000-0000-4000-8000-${personId.toString(16).padStart(12, "0")}`;

export const createProviderSchema = Effect.gen(
  function* createProviderSchema() {
    const sql = yield* SqlClient;
    yield* sql`create schema auth`;
    yield* sql`create table auth.users (
    id uuid primary key,
    email text,
    raw_app_meta_data jsonb not null default '{}'::jsonb,
    created_at timestamptz,
    updated_at timestamptz,
    phone text,
    last_sign_in_at timestamptz,
    email_confirmed_at timestamptz,
    invited_at timestamptz,
    phone_confirmed_at timestamptz
  )`;
    yield* sql`create table auth.identities (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    provider text not null,
    created_at timestamptz,
    updated_at timestamptz,
    last_sign_in_at timestamptz
  )`;
    yield* sql`create table auth.sessions (
    id uuid primary key,
    user_id uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz,
    updated_at timestamptz,
    not_after timestamptz,
    user_agent text,
    ip inet
  )`;
    yield* createAuthViews(sql);
  }
);

/** Public commands must not mutate provider records directly. */
export const providerSnapshot = Effect.gen(function* providerSnapshot() {
  const sql = yield* SqlClient;

  return yield* sql`select * from (
    select 'users' as kind, to_jsonb(u) as row from auth.users u
    union all select 'identities', to_jsonb(i) from auth.identities i
    union all select 'sessions', to_jsonb(s) from auth.sessions s
  ) records order by kind, row::text`;
});
