CREATE TABLE "company_address" (
	"address" text PRIMARY KEY,
	"person_id" integer,
	"team_id" integer,
	CONSTRAINT "company_address_one_owner" CHECK (("person_id" is null) <> ("team_id" is null)),
	CONSTRAINT "company_address_lowercase" CHECK ("address" = lower("address"))
);
--> statement-breakpoint
CREATE INDEX "company_address_person_idx" ON "company_address" ("person_id");--> statement-breakpoint
CREATE INDEX "company_address_team_idx" ON "company_address" ("team_id");--> statement-breakpoint
ALTER TABLE "company_address" ADD CONSTRAINT "company_address_person_id_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "company_address" ADD CONSTRAINT "company_address_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;