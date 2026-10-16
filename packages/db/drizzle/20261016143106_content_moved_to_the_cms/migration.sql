ALTER TABLE "article_department" DROP CONSTRAINT "article_department_article_id_article_id_fkey";--> statement-breakpoint
DROP TABLE "article";--> statement-breakpoint
DROP TABLE "article_department";--> statement-breakpoint
DROP TABLE "sponsor";--> statement-breakpoint
DROP TABLE "static_content";--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_action", ADD CONSTRAINT "audit_log_action" CHECK ("action" in ('department.created', 'department.updated', 'fieldOfStudy.created', 'fieldOfStudy.updated', 'socialEvent.created', 'publicFile.registered'));--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_entity", ADD CONSTRAINT "audit_log_entity" CHECK ("entity" in ('Department', 'Semester', 'FieldOfStudy', 'Article', 'SocialEvent', 'PublicFile'));--> statement-breakpoint
DROP TYPE "sponsor_size";