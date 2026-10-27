-- Existing rows are authoritative. A cross-table collision fails the migration rather than choosing an owner.
INSERT INTO "company_address" ("address", "person_id")
SELECT "company_email", "id" FROM "person" WHERE "company_email" IS NOT NULL;--> statement-breakpoint
INSERT INTO "company_address" ("address", "team_id")
SELECT "group_email", "id" FROM "team" WHERE "group_email" IS NOT NULL;
