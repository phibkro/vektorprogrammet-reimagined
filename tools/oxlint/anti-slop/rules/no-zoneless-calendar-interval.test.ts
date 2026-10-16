// Run with `node --test`: the Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";

import { RuleTester } from "vite-plus/lint/plugins-dev";

import { noZonelessCalendarIntervalRule } from "./no-zoneless-calendar-interval.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const zoneless = [{ messageId: "zonelessCalendarInterval" }];

new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
  "no-zoneless-calendar-interval",
  noZonelessCalendarIntervalRule,
  {
    valid: [
      // Negative controls. Elapsed time does not depend on the session TimeZone
      // (migration 0077 and packages/database/src/oauth-live.ts).
      "const sql = `SELECT created_at + interval '720 hours' FROM families`;",
      "const sql = \"UPDATE t SET at = now() - interval '90 minutes'\";",
      "const sql = `SELECT '168:00:00'::interval`;",
      "const sql = `SELECT now() + make_interval(secs => $1)`;",
      "const sql = `SELECT now() + make_interval(hours => 2, mins => 30)`;",
      // A calendar shift in a named zone.
      "const sql = `SELECT date_add(now(), interval '1 day', 'UTC')`;",
      "const sql = `SELECT date_subtract(${column}, '1 mon'::interval, 'Europe/Oslo')`;",
      // Prose and non-interval quotes.
      'const note = "Refresh families last 30 days";',
      "const sql = `SELECT 'mon' AS day, interval_days FROM t`;",
    ],
    invalid: [
      // Migration 0027: the check that rejected the code exchange in Europe/Oslo.
      {
        code: "const sql = `CHECK (absolute_expires_at = created_at + interval '30 days')`;",
        errors: zoneless,
      },
      {
        code: "const sql = `LEAST(to_timestamp($2) + interval '7 days', absolute_expires_at)`;",
        errors: zoneless,
      },
      {
        code: "const sql = \"SELECT now() - INTERVAL '1 day'\";",
        errors: zoneless,
      },
      {
        code: "const sql = `SELECT now() + '2 weeks'::interval`;",
        errors: zoneless,
      },
      {
        code: "const sql = `SELECT now() + interval '1 year 2 mons'`;",
        errors: zoneless,
      },
      {
        code: "const sql = `SELECT now() + interval 'P1M'`;",
        errors: zoneless,
      },
      {
        code: "const sql = `SELECT now() + make_interval(days => ${n})`;",
        errors: zoneless,
      },
      // A zone elsewhere in the statement does not name the zone of this shift.
      {
        code: "const sql = `SELECT date_add(now(), interval '1 hour', 'UTC') + interval '1 day'`;",
        errors: zoneless,
      },
    ],
  }
);
