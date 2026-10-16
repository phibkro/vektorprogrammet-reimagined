-- Custom SQL migration: the DML-only grants for the spike schema. Phase 1's default privileges cover only `public`.
-- `vp_app` gets no DDL right and no ownership; Hyperdrive connects as this role.
GRANT USAGE ON SCHEMA "spike_0000" TO "vp_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "spike_0000" TO "vp_app";--> statement-breakpoint
GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA "spike_0000" TO "vp_app";
