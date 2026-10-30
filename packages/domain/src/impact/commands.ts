/**
 * The handlers of the impact domain (spec 0027): the report that an administrator reads, and the close of the ended
 * semesters that the job `impactClose` runs. Both read the same ports; nothing here reads a raw count out of a snapshot
 * except through `release`.
 */
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Predicate,
  Record as Rec,
} from "effect";

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
import type {
  CloseOutcome,
  ImpactReport,
  ReportCell,
  Snapshot,
} from "./services.ts";
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

/** The answer that a snapshot gives for its cell: the closed value under the present definition, else why not. */
const closedAnswer = (
  measure: MeasureDeclaration,
  snapshot: Snapshot
): Answer =>
  snapshot.definitionHash === definitionHash(measure)
    ? Answer.cases.Available.make({
        coverage: snapshot.coverage,
        value: snapshot.value,
      })
    : Answer.cases.Unavailable.make({
        reason: "closed under another definition of the measure",
      });

/**
 * The answers for the cells of one lattice, with each cell's id: a closed cell from its snapshot, and every other cell
 * from the live source in one call, so that the cells it answers come from one read of the records.
 */
const answersFor = Effect.fnUntraced(function* answersFor(
  measure: MeasureDeclaration,
  snapshots: readonly Snapshot[],
  source: ImpactSource["Service"],
  slots: readonly Slot[]
) {
  const open = Arr.filter(slots, (slot) =>
    Option.isNone(snapshotOf(snapshots, slot))
  );

  const live = Rec.fromEntries(
    Arr.map(
      Arr.zip(open, yield* source.answers(open)),
      ([slot, answer]) => [slotId(slot), answer] as const
    )
  );

  return Arr.map(slots, (slot) => {
    const id = slotId(slot);

    return [
      id,
      Option.match(snapshotOf(snapshots, slot), {
        onNone: () =>
          live[id] ??
          Answer.cases.Unavailable.make({ reason: "the cell was not asked" }),
        onSome: (snapshot) => closedAnswer(measure, snapshot),
      }),
    ] as const;
  });
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

          const answers = yield* answersFor(
            measure,
            closed,
            source,
            slotsOf(input)
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

interface CloseInput {
  readonly closed: readonly Snapshot[];
  readonly measure: MeasureDeclaration;
  readonly now: DateTime.Utc;
  readonly semester: Semester;
  readonly slots: readonly Slot[];
  readonly snapshots: ImpactSnapshots["Service"];
  readonly source: ImpactSource["Service"];
}

const NOTHING: CloseOutcome = { alreadyClosed: 0, closed: 0, unavailable: 0 };

const draftOf = (
  input: CloseInput,
  slot: Slot,
  answer: Answer
): readonly Snapshot[] =>
  Answer.match(answer, {
    Available: ({ coverage, value }): readonly Snapshot[] => [
      {
        closedAt: input.now,
        coverage,
        definitionHash: definitionHash(input.measure),
        department: Scope.match(slot.scope, {
          All: () => Option.none(),
          Department: ({ department }) => Option.some(department),
          School: () => Option.none(),
        }),
        measure: input.measure.id,
        semester: input.semester,
        source: "reimagined",
        sourceRef: Option.none(),
        value,
      },
    ],
    Unavailable: (): readonly Snapshot[] => [],
  });

/**
 * One lattice (a measure in a semester): closed whole or not at all. The source answers all its cells from one read, and
 * the snapshots are written in one statement, so the closed cells relate as the cells of the report do. A lattice that
 * has a closed cell already is left as it is (a department that came after the semester closed would otherwise be closed
 * from a later state), and one that the source cannot answer in full is not closed: an Unavailable is not frozen, or the
 * semester could never be filled in later.
 */
const closeLattice = Effect.fnUntraced(function* closeLattice(
  input: CloseInput
) {
  const { closed, slots, snapshots, source } = input;

  const present = Arr.filter(slots, (slot) =>
    Option.isSome(snapshotOf(closed, slot))
  );

  if (present.length === slots.length) {
    return { ...NOTHING, alreadyClosed: slots.length };
  }

  if (present.length > 0) {
    return {
      ...NOTHING,
      alreadyClosed: present.length,
      unavailable: slots.length - present.length,
    };
  }

  const answers = yield* source.answers(slots);

  const drafts = Arr.flatten(
    Arr.zipWith(slots, answers, (slot, answer) => draftOf(input, slot, answer))
  );

  if (drafts.length < slots.length) {
    return { ...NOTHING, unavailable: slots.length };
  }

  const written = yield* snapshots.close(drafts);

  return { ...NOTHING, alreadyClosed: slots.length - written, closed: written };
});

/**
 * Closes every lattice of the standard grain of every ended semester that the source answers in full (spec 0027 D8). A
 * cell is counted `unavailable` when its lattice was not closed. Run twice, the second run closes nothing.
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
          closeLattice({
            closed,
            measure,
            now,
            semester,
            slots: slotsOf({
              audience: "standard",
              departments: ids,
              measure,
              schools: [],
              semester,
            }),
            snapshots,
            source,
          })
        );
      })
    );

    return Arr.reduce(
      Arr.flatten(outcomes),
      NOTHING,
      (sum, outcome): CloseOutcome => ({
        alreadyClosed: sum.alreadyClosed + outcome.alreadyClosed,
        closed: sum.closed + outcome.closed,
        unavailable: sum.unavailable + outcome.unavailable,
      })
    );
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
