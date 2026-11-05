-- A person's memberships in one team never overlap (spec 0006, ADR 0002). Drizzle cannot model an exclusion
-- constraint, so it is a custom migration. `btree_gist` lets one GiST index compare the person and the team for
-- equality beside the overlap of the closed range of semester ordinals (`start_ordinal` and `end_ordinal` are
-- generated from the term). A term that starts the semester after another ends does not overlap it.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_no_overlap" EXCLUDE USING gist (
	"person_id" WITH =,
	"team_id" WITH =,
	int4range("start_ordinal", "end_ordinal", '[]') WITH &&
);
