-- This prototype migrates fresh/synthetic data, not live credentials. Refuse an unrehearsed cutover.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM code WHERE purpose <> 'alumniConsent')
    OR EXISTS (SELECT 1 FROM outbox WHERE kind = 'SetCredential' OR (kind = 'IssueCode' AND payload->>'purpose' <> 'alumniConsent')) THEN
    RAISE EXCEPTION 'Legacy credential intents require an explicitly rehearsed migration before Supabase cutover';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "site_content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"collection" text NOT NULL,
	"slug" text NOT NULL,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"draft_published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "site_content_collection_slug_unique" UNIQUE("collection","slug"),
	CONSTRAINT "site_content_collection_check" CHECK ("collection" in ('texts', 'news', 'sponsors', 'faq', 'teams')),
	CONSTRAINT "site_content_published_date" CHECK (("published" is null) = ("published_at" is null))
);
--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_kind", ADD CONSTRAINT "outbox_kind" CHECK ("kind" in ('Email', 'IssueCode', 'InviteAccount', 'SlackPost', 'WorkspaceChange'));--> statement-breakpoint
ALTER TABLE "code" DROP CONSTRAINT "code_purpose", ADD CONSTRAINT "code_purpose" CHECK ("purpose" in ('alumniConsent'));