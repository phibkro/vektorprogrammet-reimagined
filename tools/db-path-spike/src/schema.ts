/**
 * The spike's own tables (spec 0000). Everything lives in the schema `spike_0000`,
 * so the Phase 1 tables in `public` stay untouched and `drop schema spike_0000 cascade`
 * is the whole table teardown. Tables carry the `spike_` prefix.
 */
import { UniqueConstraint } from "@vektorprogrammet/db";
import {
  date,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

const SPIKE_SCHEMA = "spike_0000";

const spikeSchema = pgSchema(SPIKE_SCHEMA);

/** Transaction checks 2, 3a, 3b and 4: one row per (run, label). */
export const spikeRow = spikeSchema.table(
  "spike_row",
  {
    label: text("label").notNull(),
    run: text("run").notNull(),
  },
  (t) => [primaryKey({ columns: [t.run, t.label] })]
);

/**
 * Checks 5, 6 and 8: the shape of Phase 1's `semester`. The unique constraint
 * carries the production name, because `classifySqlFailure` maps by constraint
 * name; the spike schema keeps it from colliding with Phase 1's.
 */
export const spikeSemester = spikeSchema.table(
  "spike_semester",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    term: text("term").notNull(),
    year: integer("year").notNull(),
  },
  (t) => [unique(UniqueConstraint.semesterTermYear).on(t.term, t.year)]
);

/** A `timestamptz` read and written as a JavaScript `Date`. */
const instant = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

/** Check 7: the four value types, written and read through Drizzle and through the raw `SqlClient`. */
export const spikeCodec = spikeSchema.table(
  "spike_codec",
  {
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    at: instant("at").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    doc: jsonb("doc").notNull(),
    run: text("run").notNull(),
    slot: integer("slot").notNull(),
  },
  (t) => [primaryKey({ columns: [t.run, t.slot] })]
);

/** Check 11: one counter per run, written and read straight back. */
export const spikeCounter = spikeSchema.table("spike_counter", {
  run: text("run").primaryKey(),
  value: integer("value").notNull(),
});
