-- Spec 0021 (ADR 0014, answer 3). The retention arithmetic is the domain's now (`retentionEnd` and the thresholds beside it in
-- `packages/domain/src/personalData/retentionEnd.ts`): the nightly run, the report and the alumni candidates read facts and
-- filter by what the domain computes, and nothing in production reads the view or the function. They stay as the test
-- oracle, re-created from the migration that made them (`20261027111351_person_last_activity_end`) by
-- `packages/db/test/support/retentionOracle.ts`. Down: run that migration's two statements again.
DROP VIEW "person_last_activity_end";
--> statement-breakpoint
DROP FUNCTION "semester_end"("semester_term", integer);
