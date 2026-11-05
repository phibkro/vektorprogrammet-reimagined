ALTER TABLE "code" ADD COLUMN "state" text;--> statement-breakpoint
UPDATE "code" SET "state" = CASE WHEN "used_at" IS NULL THEN 'Usable' ELSE 'Used' END;--> statement-breakpoint
ALTER TABLE "code" ALTER COLUMN "state" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "code" DROP COLUMN "used_at";--> statement-breakpoint
ALTER TABLE "code" ADD CONSTRAINT "code_state" CHECK ("state" in ('Unsent', 'Usable', 'Used'));
