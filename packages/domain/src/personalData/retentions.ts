/**
 * The retentions that several tables share. A retention is a trigger and a period; the periods are in `periods.ts`, and
 * a table's declaration names one of these instead of spelling the pair again.
 */
import { Retention, starts } from "./declaration.ts";
import type { Words } from "./declaration.ts";
import { Periods } from "./periods.ts";

/**
 * "With the person core": one year after the person's last activity ends, five while a `keepDetails` consent is
 * current (§11.9 decision 1). The person's own row, and every row that lives and dies with it, declares this.
 */
export const withThePersonCore: Retention = Retention.make({
  longerWhile: {
    consent: "keepDetails",
    period: Periods.personCoreWithKeepDetails,
  },
  period: Periods.personCore,
  trigger: starts.lastActivityEnd,
});

/** A row that is dead when an instant column says so, and is kept `period` after it (`event` says what the column records). */
export const afterColumn = (
  column: string,
  period: Retention["period"],
  event: Words
): Retention =>
  Retention.make({ period, trigger: starts.column(column, event) });
