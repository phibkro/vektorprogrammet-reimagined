import { defineRule } from "vite-plus/lint/plugins";

// An interval constant in SQL text, as `interval '30 days'` or `'30 days'::interval`.
const INTERVAL_CONSTANT =
  /\binterval\s*'([^']*)'|'([^']*)'\s*::\s*interval\b/giu;

// A calendar amount: days, weeks, months, years, or longer, also in ISO 8601 form (P1M).
const CALENDAR_AMOUNT =
  /\d\s*(?:millenni\w*|centur\w*|decades?|years?|yrs?|y|mons?|months?|weeks?|w|days?|d)\b|^\s*[+-]?P[^T]*[YMWD]/iu;

// make_interval with a calendar argument, such as `make_interval(days => 7)`.
const CALENDAR_MAKE_INTERVAL =
  /\bmake_interval\s*\([^)]*?\b(?:years|months|weeks|days)\s*=>/iu;

// The zone argument of date_add or date_subtract after the interval: `, 'UTC')`.
const EXPLICIT_ZONE = /^\s*,\s*'[^']*'\s*\)/u;

const hasZonelessCalendarShift = (text: string) =>
  CALENDAR_MAKE_INTERVAL.test(text) ||
  [...text.matchAll(INTERVAL_CONSTANT)].some(
    ({ 0: constant, 1: written, 2: cast, index }) =>
      CALENDAR_AMOUNT.test(written ?? cast ?? "") &&
      !EXPLICIT_ZONE.test(text.slice(index + constant.length))
  );

/** Ban SQL that shifts an instant by a calendar amount in the session TimeZone. */
export const noZonelessCalendarIntervalRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow calendar interval arithmetic in SQL text, such as `+ interval '7 days'`, unless `date_add` or `date_subtract` names its time zone.",
    },
    messages: {
      zonelessCalendarInterval:
        "Shift the instant by elapsed time (`interval '168 hours'`), or name the zone of a calendar shift with `date_add(instant, interval '7 days', 'UTC')` or `date_subtract`. PostgreSQL adds days, weeks, months, and years to a timestamptz in the session TimeZone, so the result moves by an hour across a daylight saving change (migration 0077).",
    },
  },
  createOnce(context) {
    return {
      TemplateElement(node) {
        if (hasZonelessCalendarShift(node.value.raw)) {
          context.report({ node, messageId: "zonelessCalendarInterval" });
        }
      },
      Literal(node) {
        if (
          typeof node.value === "string" &&
          hasZonelessCalendarShift(node.value)
        ) {
          context.report({ node, messageId: "zonelessCalendarInterval" });
        }
      },
    };
  },
});
