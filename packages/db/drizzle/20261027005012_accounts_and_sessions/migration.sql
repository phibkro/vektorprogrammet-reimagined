CREATE TABLE "account" (
	"person_id" integer PRIMARY KEY,
	"state" text NOT NULL,
	CONSTRAINT "account_state" CHECK ("state" in ('Active', 'Deactivated', 'Invited'))
);
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"credential_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "auth_account_provider_account_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"token" text NOT NULL CONSTRAINT "auth_session_token_unique" UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "auth_session_no_ip" CHECK ("ip_address" is null or "ip_address" = '')
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY,
	"person_id" integer NOT NULL CONSTRAINT "auth_user_person_unique" UNIQUE,
	"name" text NOT NULL,
	"email" text NOT NULL CONSTRAINT "auth_user_email_unique" UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "captured_mail" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "captured_mail_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"sent_at" timestamp with time zone NOT NULL,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code" (
	"purpose" text,
	"subject" integer,
	"hash" text NOT NULL CONSTRAINT "code_hash_unique" UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "code_purpose_subject_pk" PRIMARY KEY("purpose","subject"),
	CONSTRAINT "code_purpose" CHECK ("purpose" in ('activation', 'resetPassword')),
	CONSTRAINT "code_hash_format" CHECK ("hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "person" DROP CONSTRAINT "person_email_unique";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "client" text DEFAULT 'server' NOT NULL;--> statement-breakpoint
UPDATE "audit_log" SET "client" = 'scheduler' WHERE "system_job" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "company_email" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_log_session_idx" ON "audit_log" ("session_id");--> statement-breakpoint
CREATE INDEX "auth_account_user_idx" ON "auth_account" ("user_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_idx" ON "auth_session" ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "person_email_unique" ON "person" ("email") WHERE "email_verified";--> statement-breakpoint
CREATE UNIQUE INDEX "person_company_email_unique" ON "person" ("company_email") WHERE "company_email" is not null;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_person_id_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id");--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_user" ADD CONSTRAINT "auth_user_person_id_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id");--> statement-breakpoint
ALTER TABLE "code" ADD CONSTRAINT "code_subject_person_id_fkey" FOREIGN KEY ("subject") REFERENCES "person"("id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_client" CHECK ("client" in ('browser', 'server', 'scheduler', 'import'));--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_company_email_lowercase" CHECK ("company_email" is null or "company_email" = lower("company_email"));--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action", ADD CONSTRAINT "audit_log_action" CHECK ("action" in ('department.created', 'department.updated', 'fieldOfStudy.created', 'fieldOfStudy.updated', 'socialEvent.created', 'publicFile.registered', 'person.registered', 'person.profileUpdated', 'account.invited', 'account.activated', 'account.deactivated', 'account.reactivated', 'account.passwordReset', 'team.created', 'team.updated', 'team.deactivated', 'membership.added', 'membership.extended', 'membership.changed', 'membership.endedEarly', 'membership.cancelled', 'adminGrant.granted', 'adminGrant.revoked', 'endingSoon.sent'));--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_entity", ADD CONSTRAINT "audit_log_entity" CHECK ("entity" in ('Department', 'Semester', 'FieldOfStudy', 'Article', 'SocialEvent', 'PublicFile', 'Person', 'Account', 'Team', 'Position', 'Membership', 'AdminGrant'));--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_kind", ADD CONSTRAINT "outbox_kind" CHECK ("kind" in ('Email', 'IssueCode', 'SetCredential', 'SlackPost'));