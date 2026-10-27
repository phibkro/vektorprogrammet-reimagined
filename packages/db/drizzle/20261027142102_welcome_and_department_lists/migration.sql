CREATE TABLE "welcome_ledger" (
	"person_id" integer PRIMARY KEY,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_report" ADD COLUMN "department_lists" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "welcome_ledger" ADD CONSTRAINT "welcome_ledger_person_id_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id");