/**
 * The adapters of evidence of operations (spec 0027). `ImpactSnapshotsLive` keeps the closed cells: an insert that never
 * changes a closed cell and a read, and no update or delete. `ImpactSourceLive` is the live source that ships: the tables
 * that placement would fill do not exist (spec 0011 is not built), so it answers every cell Unavailable, with the reason.
 * When placement lands, this is the one adapter that changes.
 */
import {
  DepartmentId,
  ImpactMeasures,
  ImpactSnapshots,
  ImpactSource,
  SemesterYear,
  Term,
} from "@vektorprogrammet/domain";
import type { Semester, Snapshot } from "@vektorprogrammet/domain";
import { and, eq } from "drizzle-orm";
import { Array as Arr, DateTime, Effect, Layer, Option, Schema } from "effect";

import { Drizzle, decodeWith } from "../internal/drizzle.ts";
import { impactSnapshot } from "../schema.ts";

const { Answer, Coverage, MeasureId, NO_SOURCE_REASON } = ImpactMeasures;

const StoredSnapshot = Schema.Struct({
  closedAt: Schema.DateTimeUtcFromDate,
  coverage: Schema.Literals(["complete", "incomplete"]),
  coverageReason: Schema.NullOr(Schema.String),
  definitionHash: Schema.String,
  departmentId: Schema.NullOr(DepartmentId),
  measure: MeasureId,
  semesterTerm: Term,
  semesterYear: SemesterYear,
  source: Schema.Literals(["legacy-import", "reimagined"]),
  sourceRef: Schema.NullOr(Schema.String),
  value: Schema.Int,
});

const coverageOf = (
  stored: typeof StoredSnapshot.Type
): ImpactMeasures.Coverage =>
  stored.coverage === "complete"
    ? Coverage.cases.Complete.make({})
    : Coverage.cases.Incomplete.make({ reason: stored.coverageReason ?? "" });

const snapshotOf = (stored: typeof StoredSnapshot.Type): Snapshot => ({
  closedAt: stored.closedAt,
  coverage: coverageOf(stored),
  definitionHash: stored.definitionHash,
  department: Option.fromNullOr(stored.departmentId),
  measure: stored.measure,
  semester: { term: stored.semesterTerm, year: stored.semesterYear },
  source: stored.source,
  sourceRef: Option.fromNullOr(stored.sourceRef),
  value: stored.value,
});

export const ImpactSnapshotsLive = Layer.effect(
  ImpactSnapshots,
  Effect.gen(function* ImpactSnapshotsLive() {
    const db = yield* Drizzle;
    const decodeAll = decodeWith(Schema.Array(StoredSnapshot));

    const read = Effect.fn("ImpactSnapshots.read")(function* read(
      wanted: Semester
    ) {
      const rows = yield* db
        .select()
        .from(impactSnapshot)
        .where(
          and(
            eq(impactSnapshot.semesterTerm, wanted.term),
            eq(impactSnapshot.semesterYear, wanted.year)
          )
        )
        .pipe(Effect.orDie);

      return Arr.map(yield* decodeAll(rows), snapshotOf);
    });

    /** One statement: a cell that is closed already conflicts and is left as it is. */
    const close = Effect.fn("ImpactSnapshots.close")(function* close(
      snapshot: Snapshot
    ) {
      const rows = yield* db
        .insert(impactSnapshot)
        .values({
          closedAt: DateTime.toDateUtc(snapshot.closedAt),
          coverage: Coverage.match(snapshot.coverage, {
            Complete: () => "complete",
            Incomplete: () => "incomplete",
          }),
          coverageReason: Coverage.match(snapshot.coverage, {
            Complete: () => null,
            Incomplete: ({ reason }) => reason,
          }),
          definitionHash: snapshot.definitionHash,
          departmentId: Option.getOrNull(snapshot.department),
          measure: snapshot.measure,
          semesterTerm: snapshot.semester.term,
          semesterYear: snapshot.semester.year,
          source: snapshot.source,
          sourceRef: Option.getOrNull(snapshot.sourceRef),
          value: snapshot.value,
        })
        .onConflictDoNothing()
        .returning({ id: impactSnapshot.id })
        .pipe(Effect.orDie);

      return rows.length > 0;
    });

    return ImpactSnapshots.of({ close, read });
  })
);

/** The source that ships: no cell has a source yet (spec 0027 D3). */
export const ImpactSourceLive = Layer.succeed(
  ImpactSource,
  ImpactSource.of({
    answer: () =>
      Effect.succeed(
        Answer.cases.Unavailable.make({ reason: NO_SOURCE_REASON })
      ),
    schools: () => Effect.succeed([]),
  })
);
