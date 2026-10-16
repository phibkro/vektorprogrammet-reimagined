-- EmDash's database role and schema (spec 0005, D1). Run once per database with psql, as an administrative
-- role: the devenv superuser locally, `neondb_owner` on Neon. Safe to run again.
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f apps/cms/db/emdash-role.sql
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v emdash_password="$PASSWORD" -f apps/cms/db/emdash-role.sql
--
-- Source: https://docs.emdashcms.com/deployment/database/#database-role-requirements
-- EmDash creates and alters its own tables (core migrations, one `ec_*` table per collection, a column per
-- field), so its role owns the schema for the lifetime of the site: CONNECT on the database, USAGE and CREATE on
-- the schema, ownership of every EmDash table. It needs no superuser, CREATEDB or CREATEROLE. The role must be
-- stable: PostgreSQL gives every object to the role that creates it, so a replacement role could read and write
-- rows but fail the next migration with "must be owner of table".
--
-- The dedicated schema `emdash` keeps EmDash apart from the application's `public` schema, where the DML-only
-- role `vp_app` works. EmDash uses PostgreSQL's active `current_schema()` and never sets `search_path`, so
-- the role's default `search_path` selects the schema. `emdash_app` holds no privilege on `public`, and
-- `vp_app` holds none on `emdash`.

SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'emdash_app') AS missing \gset
\if :missing
  CREATE ROLE emdash_app LOGIN;
\endif

-- Local trust authentication needs no password; Neon does.
\if :{?emdash_password}
  ALTER ROLE emdash_app PASSWORD :'emdash_password';
\endif

SELECT format('GRANT CONNECT ON DATABASE %I TO emdash_app', current_database()) \gexec

CREATE SCHEMA IF NOT EXISTS emdash AUTHORIZATION emdash_app;

ALTER SCHEMA emdash OWNER TO emdash_app;

SELECT format('ALTER ROLE emdash_app IN DATABASE %I SET search_path = emdash', current_database()) \gexec
