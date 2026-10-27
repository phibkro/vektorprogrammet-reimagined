/**
 * The words of a duration, in each language (spec 0007b R3 item 28). This is the one place that spells a period out, and it
 * sits below the texts and the declarations that state one: a reason, a purpose or a command's summary that says how long
 * something is kept builds the phrase from the value that the retention job applies (`Periods`, `codePolicy`), so the
 * phrase follows the value, and a test that perturbs every period proves it (`test/personalData/periodsInText.test.ts`).
 */
import { Duration, days } from "./declaration.ts";

export type Language = "en" | "no";

const plural = (count: number, one: string, many: string): string =>
  count === 1 ? one : many;

export const durationWords = (duration: Duration, language: Language): string =>
  Duration.match(duration, {
    Days: ({ count }) =>
      language === "no"
        ? `${count} ${plural(count, "dag", "dager")}`
        : `${count} ${plural(count, "day", "days")}`,
    Months: ({ count }) =>
      language === "no"
        ? `${count} ${plural(count, "måned", "måneder")}`
        : `${count} ${plural(count, "month", "months")}`,
    Years: ({ count }) =>
      language === "no"
        ? `${count} år`
        : `${count} ${plural(count, "year", "years")}`,
  });

const SECONDS_PER_HOUR = 60 * 60;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

/** How long a code lives (`codePolicy`, in seconds): in days when it is a whole number of them, in hours otherwise. */
export const lifetimeWords = (seconds: number, language: Language): string => {
  if (seconds % SECONDS_PER_DAY === 0) {
    return durationWords(days(seconds / SECONDS_PER_DAY), language);
  }

  const hours = seconds / SECONDS_PER_HOUR;

  return language === "no"
    ? `${hours} ${plural(hours, "time", "timer")}`
    : `${hours} ${plural(hours, "hour", "hours")}`;
};
