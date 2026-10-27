-- Spec 0007b. Two derivations that Drizzle cannot model, each with one definition that the retention job and the alumni
-- request read: when a semester ends, and when a person's last activity ends.
--
-- `semester_end` is `semesterWindow(semester).end` of the domain (RULE-022): the first instant of the next period at Oslo
-- midnight. Vår Y ends on 1 August Y, and Høst Y on 1 January Y+1. `packages/db/test/personalData.postgres.test.ts` checks
-- the two definitions against each other over a range of years.
CREATE FUNCTION "semester_end"("term" "semester_term", "year" integer) RETURNS timestamp with time zone
	LANGUAGE sql STABLE PARALLEL SAFE
	AS $$
		SELECT CASE "term"
			WHEN 'VAR' THEN make_timestamptz("year", 8, 1, 0, 0, 0, 'Europe/Oslo')
			ELSE make_timestamptz("year" + 1, 1, 1, 0, 0, 0, 'Europe/Oslo')
		END
	$$;
--> statement-breakpoint
-- The end of a person's last activity: the later of the end of their last membership and the end of their last admin place
-- (a valid place keeps a person active, so the job never removes the account of an administrator whose place outlasts
-- their membership), and their creation when there is neither. Spec 0009 adds the admission period of the last
-- application, and spec 0011 the placements.
CREATE VIEW "person_last_activity_end" AS
	SELECT "p"."id" AS "person_id",
		coalesce(greatest("m"."ends_at", "g"."ends_at"), "p"."created_at") AS "at"
	FROM "person" AS "p"
	LEFT JOIN (
		SELECT "person_id", max("semester_end"("end_term", "end_year")) AS "ends_at"
		FROM "membership"
		GROUP BY "person_id"
	) AS "m" ON "m"."person_id" = "p"."id"
	LEFT JOIN (
		SELECT "person_id", max("until") AS "ends_at"
		FROM "admin_grant"
		GROUP BY "person_id"
	) AS "g" ON "g"."person_id" = "p"."id";
