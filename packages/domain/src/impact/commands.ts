/**
 * The handlers of the impact domain (spec 0027): the report that an administrator reads, and the close of the ended
 * semesters that the job `impactClose` runs. Both read the same ports; nothing here reads a raw count out of a snapshot
 * except through `release`.
 */
import { Array as Arr, DateTime, Effect, Option, Predicate } from "effect";

import * as Commands from "../kernel/commands.ts";
import { semesterWindow, sortNewestFirst } from "../organisation/semester.ts";
import type { Semester } from "../organisation/semester.ts";
import {
  DepartmentRepository,
  SemesterRepository,
} from "../organisation/services.ts";
import type { DepartmentId } from "../shared/ids.ts";
import {
  ImpactDomain,
  ImpactRpc,
  closeImpact,
  listImpact,
} from "./declaration.ts";
import { releaseLattice, slotsOf } from "./lattice.ts";
import type { LatticeInput, SchoolsOf } from "./lattice.ts";
import {
  Answer,
  Measures,
  Minimum,
  Scope,
  definitionHash,
  mayRead,
  slotId,
} from "./measures.ts";
import type { Audience, MeasureDeclaration, Slot } from "./measures.ts";
import { ImpactSnapshots } from "./services.ts";
import type { ImpactReport, ReportCell, Snapshot } from "./services.ts";
import { ImpactSource } from "./source.ts";

/** The semesters that have ended at `now`, newest first. */
const endedSemesters = Effect.fnUntraced(function* endedSemesters() {
  const semesters = yield* SemesterRepository;
  const now = yield* DateTime.now;

  return sortNewestFirst(
    Arr.filter(yield* semesters.list, (semester) =>
      DateTime.isLessThanOrEqualTo(semesterWindow(semester).end, now)
    )
  );
});

const asSemester = ({ term, year }: Semester): Semester => ({ term, year });

/** The snapshot that closed this cell, if one did. Cells of the school grain are never snapshots. */
const snapshotOf = (
  snapshots: readonly Snapshot[],
  slot: Slot
): Option.Option<Snapshot> =>
  Predicate.isTagged(slot.scope, "School")
    ? Option.none()
    : Arr.findFirst(
        snapshots,
        (snapshot) =>
          snapshot.measure === slot.measure &&
          Scope.match(slot.scope, {
            All: () => Option.isNone(snapshot.department),
            Department: ({ department }) =>
              Option.getOrNull(snapshot.department) === department,
            School: () => false,
          })
      );

/**
 * One cell's answer: the closed value when a snapshot holds one under the measure's present definition, "closed under
 * another definition" when it holds one under a different definition, and the live source's answer otherwise.
 */
const answerFor = (
  measure: MeasureDeclaration,
  snapshots: readonly Snapshot[],
  source: ImpactSource["Service"],
  slot: Slot
): Effect.Effect<Answer> =>
  Option.match(snapshotOf(snapshots, slot), {
    onNone: () => source.answer(slot),
    onSome: (snapshot) =>
      Effect.succeed(
        snapshot.definitionHash === definitionHash(measure)
          ? Answer.cases.Available.make({
              coverage: snapshot.coverage,
              value: snapshot.value,
            })
          : Answer.cases.Unavailable.make({
              reason: "closed under another definition of the measure",
            })
      ),
  });

/** The schools of every department in the semester: only the restricted audience asks, and only for a measure that has the grain. */
const schoolsFor = Effect.fnUntraced(function* schoolsFor(
  source: ImpactSource["Service"],
  audience: Audience,
  measure: MeasureDeclaration,
  semester: Semester,
  departments: readonly DepartmentId[]
) {
  if (!mayRead(audience, "school") || !Arr.contains(measure.grains, "school")) {
    return [] satisfies SchoolsOf;
  }

  return yield* Effect.forEach(departments, (department) =>
    Effect.map(
      source.schools(semester, department),
      (schools) => [department, schools] as const
    )
  );
});

/**
 * The report for an audience: every ended semester, each measure's lattice, released. The cells of an audience's grains
 * only; a closed cell from its snapshot, the others from the live source.
 */
export const impactReport = Effect.fn("impactReport")(function* impactReport(
  audience: Audience
) {
  const source = yield* ImpactSource;
  const snapshots = yield* ImpactSnapshots;
  const departments = yield* (yield* DepartmentRepository).list;
  const semesters = yield* endedSemesters();
  const ids = Arr.map(departments, ({ id }) => id);

  const perSemester = yield* Effect.forEach(semesters, (stored) =>
    Effect.gen(function* oneSemester() {
      const semester = asSemester(stored);
      const closed = yield* snapshots.read(semester);

      return yield* Effect.forEach(Measures, (measure) =>
        Effect.gen(function* oneMeasure() {
          const input: LatticeInput = {
            audience,
            departments: ids,
            measure,
            schools: yield* schoolsFor(
              source,
              audience,
              measure,
              semester,
              ids
            ),
            semester,
          };

          const answers = yield* Effect.forEach(slotsOf(input), (slot) =>
            Effect.map(
              answerFor(measure, closed, source, slot),
              (answer) => [slotId(slot), answer] as const
            )
          );

          return Arr.map(
            releaseLattice(
              input,
              (slot) =>
                Option.match(
                  Arr.findFirst(answers, ([id]) => id === slotId(slot)),
                  {
                    onNone: () =>
                      Answer.cases.Unavailable.make({
                        reason: "the cell was not asked",
                      }),
                    onSome: ([, answer]) => answer,
                  }
                ),
              Minimum.value
            ),
            ({ released, slot }): ReportCell => ({
              measure: slot.measure,
              released,
              scope: slot.scope,
              semester,
            })
          );
        })
      );
    })
  );

  return {
    audience,
    cells: Arr.flatten(Arr.flatten(perSemester)),
    departments: Arr.map(departments, ({ id, name }) => ({ id, name })),
    measures: Measures,
    minimum: Minimum.value,
    semesters: Arr.map(semesters, asSemester),
  } satisfies ImpactReport;
});

type CloseResult = "alreadyClosed" | "closed" | "unavailable";

interface CloseInput {
  readonly closed: readonly Snapshot[];
  readonly measure: MeasureDeclaration;
  readonly now: DateTime.Utc;
  readonly semester: Semester;
  readonly slot: Slot;
  readonly snapshots: ImpactSnapshots["Service"];
  readonly source: ImpactSource["Service"];
}

/** One cell: left alone when closed, asked of the source otherwise, and written only when the source answered. */
const closeCell = (input: CloseInput): Effect.Effect<CloseResult> => {
  const { closed, measure, now, semester, slot, snapshots, source } = input;

  if (Option.isSome(snapshotOf(closed, slot))) {
    return Effect.succeed("alreadyClosed");
  }

  return Effect.flatMap(source.answer(slot), (answer) =>
    Answer.match(answer, {
      Available: ({ coverage, value }): Effect.Effect<CloseResult> =>
        Effect.map(
          snapshots.close({
            closedAt: now,
            coverage,
            definitionHash: definitionHash(measure),
            department: Scope.match(slot.scope, {
              All: () => Option.none(),
              Department: ({ department }) => Option.some(department),
              School: () => Option.none(),
            }),
            measure: measure.id,
            semester,
            source: "reimagined",
            sourceRef: Option.none(),
            value,
          }),
          (written) => (written ? "closed" : "alreadyClosed")
        ),
      Unavailable: (): Effect.Effect<CloseResult> =>
        Effect.succeed("unavailable"),
    })
  );
};

/**
 * Closes every cell of the standard grain of every ended semester that has no snapshot and that the source answers
 * (spec 0027 D8). A cell that the source cannot answer is counted and not written: an Unavailable is not frozen, or the
 * semester could never be filled in later. Run twice, the second run closes nothing.
 */
export const closeEndedSemesters = Effect.fn("closeEndedSemesters")(
  function* closeEndedSemesters() {
    const source = yield* ImpactSource;
    const snapshots = yield* ImpactSnapshots;
    const departments = yield* (yield* DepartmentRepository).list;
    const now = yield* DateTime.now;
    const semesters = yield* endedSemesters();
    const ids = Arr.map(departments, ({ id }) => id);

    const outcomes = yield* Effect.forEach(semesters, (stored) =>
      Effect.gen(function* closeSemester() {
        const semester = asSemester(stored);
        const closed = yield* snapshots.read(semester);

        return yield* Effect.forEach(Measures, (measure) =>
          Effect.forEach(
            slotsOf({
              audience: "standard",
              departments: ids,
              measure,
              schools: [],
              semester,
            }),
            (slot) =>
              closeCell({
                closed,
                measure,
                now,
                semester,
                slot,
                snapshots,
                source,
              })
          )
        );
      })
    );

    const all = Arr.flatten(Arr.flatten(outcomes));

    const count = (which: "alreadyClosed" | "closed" | "unavailable") =>
      Arr.filter(all, (outcome) => outcome === which).length;

    return {
      alreadyClosed: count("alreadyClosed"),
      closed: count("closed"),
      unavailable: count("unavailable"),
    };
  }
);

export const ImpactHandlers = ImpactRpc.toLayer({
  closeImpact: ImpactDomain.handle(closeImpact, {
    resource: () => Effect.succeed({}),
    run: () => closeEndedSemesters(),
  }),
  listImpact: ImpactDomain.handle(listImpact, {
    resource: () => Effect.succeed({}),
    run: () => impactReport("standard"),
  }),
});

/** The impact commands behind the in-process client; see `Commands.inProcess`. */
const withImpact = Commands.inProcess(ImpactRpc, ImpactHandlers);

/** The administrator's read: the released cells of the standard audience, as the command answers it. */
export const impactView = withImpact((client) => client.listImpact());

/** The job `impactClose`: the Worker's `scheduled` handler runs it as `System("impactClose")`. */
export const impactCloseJob = withImpact((client) => client.closeImpact());
