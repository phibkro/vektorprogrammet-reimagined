import { Effect } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";

/** Bootstrap-owned security-barrier views expose only provider fields used by the server. */
export const createAuthViews = (sql: SqlClient) =>
  Effect.gen(function* createViews() {
    yield* sql`create schema if not exists vektor_private`;
    yield* sql`revoke all on schema vektor_private from public`;
    yield* sql`create or replace view vektor_private.users with (security_barrier = true) as
    select id, email, phone, created_at, updated_at, last_sign_in_at, email_confirmed_at,
      phone_confirmed_at, invited_at, raw_app_meta_data->>'personId' as person_id from auth.users`;
    yield* sql`create or replace view vektor_private.identities with (security_barrier = true) as
    select id, user_id, provider, created_at, updated_at, last_sign_in_at from auth.identities`;
    yield* sql`create or replace view vektor_private.sessions with (security_barrier = true) as
    select id, user_id, created_at, updated_at, not_after, user_agent, ip from auth.sessions`;
    yield* sql`revoke all on vektor_private.users, vektor_private.identities, vektor_private.sessions from public`;
  });
