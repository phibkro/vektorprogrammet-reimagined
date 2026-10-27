CREATE TABLE "admin_list" (
	"id" integer PRIMARY KEY,
	CONSTRAINT "admin_list_singleton" CHECK ("id" = 1)
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_entity", ADD CONSTRAINT "audit_log_entity" CHECK ("entity" in ('Department', 'Semester', 'FieldOfStudy', 'Article', 'SocialEvent', 'PublicFile', 'Person', 'Account', 'Team', 'Position', 'Membership', 'AdminGrant', 'AdminList'));