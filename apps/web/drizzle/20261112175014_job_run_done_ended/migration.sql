-- Refuse historical violations; never invent a completion time or silently repair data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "job_run" WHERE "outcome" = 'done' AND "ended_at" IS NULL) THEN
    RAISE EXCEPTION 'job_run_done_ended preflight: done rows without ended_at require explicit operator repair';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_done_ended" CHECK ("outcome" <> 'done' or "ended_at" is not null);