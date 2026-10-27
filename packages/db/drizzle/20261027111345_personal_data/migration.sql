CREATE TABLE "alumni_request" (
	"engagement_end" timestamp with time zone,
	"person_id" integer,
	"requested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "alumni_request_pk" PRIMARY KEY("person_id","engagement_end")
);
--> statement-breakpoint
CREATE TABLE "consent" (
	"decided_at" timestamp with time zone GENERATED ALWAYS AS (greatest(given_at, coalesce(withdrawn_at, given_at))) STORED,
	"given_at" timestamp with time zone NOT NULL,
	"kind" text,
	"person_id" integer,
	"text_version" integer NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "consent_person_kind_pk" PRIMARY KEY("person_id","kind"),
	CONSTRAINT "consent_kind" CHECK ("kind" in ('keepDetails', 'news', 'photo')),
	CONSTRAINT "consent_text_version" CHECK ("text_version" > 0),
	CONSTRAINT "consent_withdrawn_after_given" CHECK ("withdrawn_at" is null or "withdrawn_at" >= "given_at")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "counts" jsonb;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "anonymised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "merged_into" integer;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "photo_key" text;--> statement-breakpoint
ALTER TABLE "alumni_request" ADD CONSTRAINT "alumni_request_person_id_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id");--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_person_id_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "person"("id");--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_merged_into_person_id_fkey" FOREIGN KEY ("merged_into") REFERENCES "person"("id");--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_photo_key_public_file_key_fkey" FOREIGN KEY ("photo_key") REFERENCES "public_file"("key");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_counts" CHECK ("counts" is null or (jsonb_typeof("counts") = 'object' and not jsonb_path_exists("counts", '$.* ? (@.type() != "number")')));--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_merged_not_self" CHECK ("merged_into" is null or "merged_into" <> "id");--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_merged_anonymised" CHECK ("merged_into" is null or "anonymised_at" is not null);--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action", ADD CONSTRAINT "audit_log_action" CHECK ("action" in ('department.created', 'department.updated', 'fieldOfStudy.created', 'fieldOfStudy.updated', 'socialEvent.created', 'publicFile.registered', 'person.registered', 'person.profileUpdated', 'account.invited', 'account.activated', 'account.deactivated', 'account.reactivated', 'account.passwordReset', 'team.created', 'team.updated', 'team.deactivated', 'membership.added', 'membership.extended', 'membership.changed', 'membership.endedEarly', 'membership.cancelled', 'adminGrant.granted', 'adminGrant.revoked', 'endingSoon.sent', 'consent.given', 'consent.withdrawn', 'person.exported', 'person.erased', 'person.merged', 'person.photoSet', 'person.photoRemoved', 'alumni.requested', 'retention.ran'));--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_entity", ADD CONSTRAINT "audit_log_entity" CHECK ("entity" in ('Department', 'Semester', 'FieldOfStudy', 'Article', 'SocialEvent', 'PublicFile', 'Person', 'Account', 'Team', 'Position', 'Membership', 'AdminGrant', 'AdminList', 'Consent', 'Retention'));--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_system_job", ADD CONSTRAINT "audit_log_system_job" CHECK ("system_job" in ('semesters', 'outboxSweep', 'endingSoon', 'retention', 'alumniConsent'));--> statement-breakpoint
ALTER TABLE "code" DROP CONSTRAINT "code_purpose", ADD CONSTRAINT "code_purpose" CHECK ("purpose" in ('activation', 'alumniConsent', 'resetPassword'));