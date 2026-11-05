CREATE TABLE "captured_slack" (
	"channel" text NOT NULL,
	"delivery_key" text CONSTRAINT "captured_slack_delivery_key_unique" UNIQUE,
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "captured_slack_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"sent_at" timestamp with time zone NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_address" (
	"address" text PRIMARY KEY,
	"person_id" integer,
	"team_id" integer,
	CONSTRAINT "company_address_one_owner" CHECK (("person_id" is null) <> ("team_id" is null)),
	CONSTRAINT "company_address_lowercase" CHECK ("address" = lower("address"))
);
--> statement-breakpoint
CREATE TABLE "job_run" (
	"attempt" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}' NOT NULL,
	"cursor" jsonb,
	"ended_at" timestamp with time zone,
	"job" text,
	"last_error" text,
	"lease_until" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"period" text,
	"started_at" timestamp with time zone,
	CONSTRAINT "job_run_pk" PRIMARY KEY("job","period"),
	CONSTRAINT "job_run_job" CHECK ("job" in ('semesters', 'outboxSweep', 'endingSoon', 'retention', 'alumniConsent', 'workspaceSync')),
	CONSTRAINT "job_run_outcome" CHECK ("outcome" in ('running', 'partial', 'done', 'failed')),
	CONSTRAINT "job_run_attempt" CHECK ("attempt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "welcome_ledger" (
	"person_id" integer PRIMARY KEY,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_report" (
	"accounts" jsonb DEFAULT '[]' NOT NULL,
	"actual" text NOT NULL,
	"completed_at" timestamp with time zone,
	"counts" jsonb DEFAULT '{}' NOT NULL,
	"department_lists" jsonb DEFAULT '[]' NOT NULL,
	"groups" jsonb DEFAULT '[]' NOT NULL,
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "workspace_report_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"issues" jsonb DEFAULT '[]' NOT NULL,
	"mode" text NOT NULL,
	"period" text NOT NULL CONSTRAINT "workspace_report_period_unique" UNIQUE,
	"semester_term" "semester_term" NOT NULL,
	"semester_year" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"unmanaged" jsonb DEFAULT '{"accounts":[],"groups":[]}' NOT NULL,
	CONSTRAINT "workspace_report_actual" CHECK ("actual" in ('read', 'unavailable')),
	CONSTRAINT "workspace_report_mode" CHECK ("mode" in ('dry-run', 'write')),
	CONSTRAINT "workspace_report_status" CHECK ("status" in ('running', 'complete', 'refused')),
	CONSTRAINT "workspace_report_completed" CHECK (("status" = 'running') = ("completed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "captured_mail" ADD COLUMN "delivery_key" text;--> statement-breakpoint
ALTER TABLE "team" ADD COLUMN "group_email" text;--> statement-breakpoint
ALTER TABLE "captured_mail" ADD CONSTRAINT "captured_mail_delivery_key_unique" UNIQUE("delivery_key");--> statement-breakpoint
CREATE INDEX "company_address_person_idx" ON "company_address" ("person_id");--> statement-breakpoint
CREATE INDEX "company_address_team_idx" ON "company_address" ("team_id");--> statement-breakpoint
CREATE INDEX "job_run_resume_idx" ON "job_run" ("job","outcome");--> statement-breakpoint
CREATE UNIQUE INDEX "team_group_email_unique" ON "team" ("group_email") WHERE "group_email" is not null;--> statement-breakpoint
ALTER TABLE "company_address" ADD CONSTRAINT "company_address_person_id_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "company_address" ADD CONSTRAINT "company_address_team_id_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "welcome_ledger" ADD CONSTRAINT "welcome_ledger_person_id_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id");--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_group_email" CHECK ("group_email" is null or "group_email" ~ '^[a-z0-9._+-]+@vektorprogrammet\.no$');--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_kind", ADD CONSTRAINT "outbox_kind" CHECK ("kind" in ('Email', 'IssueCode', 'SetCredential', 'SlackPost', 'WorkspaceChange'));--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_system_job", ADD CONSTRAINT "audit_log_system_job" CHECK ("system_job" in ('semesters', 'outboxSweep', 'endingSoon', 'retention', 'alumniConsent', 'workspaceSync'));