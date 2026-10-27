/**
 * What the audit domain declares about its stored columns (spec 0007b): one row per write, with ids and action names and
 * never values (INFORMATION_MODEL §11.3). The row is the record of what a person did, so it is the person's data for as
 * long as it is kept. A retention run writes one row whose `counts` are integers.
 */
import {
  Rules,
  columns,
  erased,
  exported,
  notPersonal,
  ofPerson,
  personal,
  table,
} from "../personalData/declaration.ts";
import { durationWords } from "../personalData/duration.ts";
import { Periods } from "../personalData/periods.ts";
import { afterColumn } from "../personalData/retentions.ts";

const auditLog = table({
  columns: {
    ...columns(
      personal({
        legalBasis: "legitimateInterest",
        onExpiry: Rules.Delete,
        purpose: "accountability",
        retention: afterColumn("at", Periods.auditRows, {
          en: "the row was written",
          no: "raden ble skrevet",
        }),
      }),
      [
        "action",
        "at",
        "client",
        "entity",
        "entity_key",
        "person_id",
        "session_id",
      ]
    ),
    counts: notPersonal(
      "Integers that say how many rows a retention run removed or anonymised per table, never a value (a check keeps every value a number)"
    ),
    id: notPersonal("A surrogate key"),
    system_job: notPersonal(
      "The name of a scheduled job: a row has a person or a job, never both"
    ),
  },
  person: ofPerson(
    "person_id",
    Rules.Follow,
    exported.rows(),
    erased.kept(
      `Ids and action names, never values, kept ${durationWords(Periods.auditRows.duration, "en")} so that the organisation can account for its own use of the data`
    )
  ),
});

export const AuditTables = { audit_log: auditLog } as const;
