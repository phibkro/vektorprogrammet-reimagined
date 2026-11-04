/**
 * Spec 0027 F2, F7 and F8 on real PostgreSQL: with the source that ships (every cell Unavailable) the report says so and
 * the close writes nothing; with a source that answers, the close writes each cell of each ended semester once, never an
 * open semester and never an Unavailable cell, two concurrent closes leave one row per cell, a closed cell keeps its
 * first value and its provenance, a cell closed under another definition is marked and not shown, and a closed cell is
 * what the report reads (and releases, with its suppression) instead of the live source.
 */
import { assert, layer } from "@effect/vitest";
import {
  DepartmentRepository,
  ImpactMeasures,
  ImpactSnapshots,
  ImpactSource,
  SemesterRepository,
  closeEndedSemesters,
  impactReport,
} from "@vektorprogrammet/domain";
import type {
  DepartmentId,
  ImpactReport,
  Semester,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Option, Predicate } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { postgresDatabase } from "./support/database.ts";
import { departmentDraft } from "./support/fixtures.ts";

const { Answer, Coverage, Measures, NO_SOURCE_REASON, Released, Scope } =
  ImpactMeasures;

const { definitionHash } = ImpactMeasures;

const complete = Coverage.cases.Complete.make({});

/** A published cell as the report makes it: the count must be publishable under the declared minimum. */
const published = (value: number) =>
  Option.match(
    ImpactMeasures.releasedCount(value, ImpactMeasures.Minimum.value),
    {
      onNone: () => assert.fail(`${value} is not publishable`),
      onSome: (count) =>
        Released.cases.Published.make({ coverage: complete, value: count }),
    }
  );

const FIRST_ENDED: Semester = { term: "VAR", year: 2019 };
const SECOND_ENDED: Semester = { term: "HOST", year: 2019 };
const ENDED = [FIRST_ENDED, SECOND_ENDED] as const;
const OPEN: Semester = { term: "VAR", year: 2099 };

const NOW = DateTime.makeUnsafe("2026-10-30T12:00:00Z");

const countSnapshots = Effect.fnUntraced(function* countSnapshots() {
  const sql = yield* SqlClient;

  const [row] = yield* sql<{
    readonly n: number;
  }>`select count(*)::int as n from impact_snapshot`;

  return row?.n ?? 0;
});

const clearSnapshots = Effect.fnUntraced(function* clearSnapshots() {
  const sql = yield* SqlClient;
  yield* sql`delete from impact_snapshot`;
});

/** Two departments and the semesters, once: the later tests find what the first made. */
const world = Effect.fnUntraced(function* world() {
  const departments = yield* DepartmentRepository;
  const semesters = yield* SemesterRepository;
  const existing = yield* departments.list;

  const made = Arr.isReadonlyArrayNonEmpty(existing)
    ? existing
    : [
        yield* departments.create(departmentDraft("ImpactA")),
        yield* departments.create(departmentDraft("ImpactB")),
      ];

  for (const semester of [...ENDED, OPEN]) {
    yield* semesters.ensure(semester);
  }

  return Arr.map(made, ({ id }) => id);
});

/** A source that answers every cell with `value(slot)`, or leaves it Unavailable when that is `undefined`. */
const sourceAnswering = (
  value: (slot: ImpactMeasures.Slot) => number | undefined
) =>
  ImpactSource.of({
    answers: (slots) =>
      Effect.succeed(
        Arr.map(slots, (slot) =>
          Option.match(Option.fromNullishOr(value(slot)), {
            onNone: () =>
              Answer.cases.Unavailable.make({
                reason: "no rows for this cell",
              }),
            onSome: (found) =>
              Answer.cases.Available.make({
                coverage: complete,
                value: found,
              }),
          })
        )
      ),
    schools: () => Effect.succeed([]),
  });

const runWith = (source: ImpactSource["Service"]) =>
  closeEndedSemesters().pipe(Effect.provideService(ImpactSource, source));

const placementsAt = (
  report: ImpactReport,
  semester: Semester,
  department: DepartmentId | null
): ImpactMeasures.Released | undefined =>
  Option.getOrUndefined(
    Option.map(
      Arr.findFirst(
        report.cells,
        (cell) =>
          cell.measure === "placements" &&
          cell.semester.year === semester.year &&
          cell.semester.term === semester.term &&
          Scope.match(cell.scope, {
            All: () => department === null,
            Department: (scope) => scope.department === department,
            School: () => false,
          })
      ),
      ({ released }) => released
    )
  );

const closing = (
  snapshots: ImpactSnapshots["Service"],
  fields: {
    readonly definitionHash: string;
    readonly department: Option.Option<DepartmentId>;
    readonly semester: Semester;
    readonly value: number;
  }
) =>
  Effect.map(
    snapshots.close([
      {
        closedAt: NOW,
        coverage: complete,
        measure: "placements",
        source: "reimagined",
        sourceRef: Option.none(),
        ...fields,
      },
    ]),
    (written) => written === 1
  );

layer(postgresDatabase(), { excludeTestServices: true })(
  "spec 0027: evidence of operations on PostgreSQL",
  (it) => {
    it.effect(
      "F2: with the source that ships every cell of the report is unavailable for the reason of D3, and the close writes nothing",
      () =>
        Effect.gen(function* shipped() {
          yield* world();
          const before = yield* countSnapshots();
          const report = yield* impactReport("standard");

          assert.isAbove(report.cells.length, 0);

          for (const cell of report.cells) {
            assert.deepStrictEqual(
              cell.released,
              Released.cases.Unavailable.make({ reason: NO_SOURCE_REASON })
            );
          }

          const outcome = yield* closeEndedSemesters();

          assert.strictEqual(outcome.closed, 0);
          assert.strictEqual(outcome.alreadyClosed, 0);
          assert.isAbove(outcome.unavailable, 0);
          assert.strictEqual(yield* countSnapshots(), before);
        })
    );

    it.effect(
      "F8, negative control: a source that answers makes the same close write every cell of every ended semester once, and none of the open one",
      () =>
        Effect.gen(function* answering() {
          const departments = yield* world();
          yield* clearSnapshots();
          const source = sourceAnswering(() => 7);

          const cells =
            ENDED.length * Measures.length * (1 + departments.length);

          const first = yield* runWith(source);

          assert.strictEqual(first.closed, cells);
          assert.strictEqual(first.unavailable, 0);

          // A second close finds everything closed already; the open semester has no row.
          const second = yield* runWith(source);

          assert.strictEqual(second.closed, 0);
          assert.strictEqual(second.alreadyClosed, cells);
          assert.strictEqual(yield* countSnapshots(), cells);

          assert.deepStrictEqual(
            yield* (yield* ImpactSnapshots).read(OPEN),
            []
          );
        })
    );

    it.effect(
      "F8: a cell that the source cannot answer is not written, and the cells that it can answer are",
      () =>
        Effect.gen(function* partial() {
          const departments = yield* world();
          yield* clearSnapshots();

          const outcome = yield* runWith(
            sourceAnswering((slot) =>
              slot.measure === "placements" ? 12 : undefined
            )
          );

          const perMeasure = ENDED.length * (1 + departments.length);

          assert.strictEqual(outcome.closed, perMeasure);
          assert.strictEqual(
            outcome.unavailable,
            perMeasure * (Measures.length - 1)
          );

          const sql = yield* SqlClient;

          const [row] = yield* sql<{
            readonly measures: number;
          }>`select count(distinct measure)::int as measures from impact_snapshot`;

          assert.strictEqual(row?.measures, 1);
        })
    );

    it.effect(
      "F8: a lattice that the source answers in part is not closed at all (its cells relate, so they close from one read or not at all)",
      () =>
        Effect.gen(function* oneMissing() {
          const [first] = yield* world();
          yield* clearSnapshots();

          // Every cell of the placements lattice has a count except one department's: the lattice is left open.
          const outcome = yield* runWith(
            sourceAnswering((slot) =>
              slot.measure === "placements" &&
              !(
                Predicate.isTagged(slot.scope, "Department") &&
                slot.scope.department === first
              )
                ? 12
                : undefined
            )
          );

          assert.strictEqual(outcome.closed, 0);
          assert.strictEqual(outcome.alreadyClosed, 0);
          assert.strictEqual(yield* countSnapshots(), 0);
          assert.isAbove(outcome.unavailable, 0);
        })
    );

    it.effect(
      "F8: a lattice with a closed cell is left as it is, and the others are closed whole",
      () =>
        Effect.gen(function* partlyClosed() {
          const departments = yield* world();
          yield* clearSnapshots();
          const snapshots = yield* ImpactSnapshots;

          // One cell of the later semester's placements lattice is closed already (a lattice before this rule, or one that a department joined after it closed).
          assert.isTrue(
            yield* closing(snapshots, {
              definitionHash: definitionHash(
                ImpactMeasures.measureOf("placements")
              ),
              department: Option.none(),
              semester: SECOND_ENDED,
              value: 40,
            })
          );

          const lattice = 1 + departments.length;
          const outcome = yield* runWith(sourceAnswering(() => 7));

          // Five lattices close whole; the sixth keeps its one cell and its first value, and its other cells stay open.
          assert.strictEqual(outcome.closed, 5 * lattice);
          assert.strictEqual(outcome.alreadyClosed, 1);
          assert.strictEqual(outcome.unavailable, lattice - 1);
          assert.strictEqual(yield* countSnapshots(), 5 * lattice + 1);

          const stored = yield* snapshots.read(SECOND_ENDED);

          const placements = Arr.filter(
            stored,
            (snapshot) => snapshot.measure === "placements"
          );

          assert.deepStrictEqual(
            Arr.map(placements, ({ value }) => value),
            [40]
          );
        })
    );

    it.effect(
      "F8: four closes at once leave one row per cell, and what they report adds up to the cells",
      () =>
        Effect.gen(function* concurrent() {
          const departments = yield* world();
          yield* clearSnapshots();
          const source = sourceAnswering(() => 9);

          const cells =
            ENDED.length * Measures.length * (1 + departments.length);

          const outcomes = yield* Effect.all(
            Arr.makeBy(4, () => runWith(source)),
            { concurrency: 4 }
          );

          assert.strictEqual(yield* countSnapshots(), cells);

          assert.strictEqual(
            Arr.reduce(outcomes, 0, (sum, { closed }) => sum + closed),
            cells
          );
        })
    );

    it.effect(
      "F7: a closed cell keeps its first value and its provenance when it is closed again",
      () =>
        Effect.gen(function* immutable() {
          const [department] = yield* world();
          yield* clearSnapshots();
          const snapshots = yield* ImpactSnapshots;
          const hash = definitionHash(ImpactMeasures.measureOf("placements"));

          const close = (value: number) =>
            closing(snapshots, {
              definitionHash: hash,
              department: Option.fromNullishOr(department),
              semester: FIRST_ENDED,
              value,
            });

          assert.isTrue(yield* close(31));
          assert.isFalse(yield* close(32));

          const [stored] = yield* snapshots.read(FIRST_ENDED);

          assert.strictEqual(stored?.value, 31);
          assert.strictEqual(stored?.source, "reimagined");
          assert.strictEqual(stored?.definitionHash, hash);
          assert.isTrue(Option.isNone(stored?.sourceRef ?? Option.some("")));
          assert.strictEqual(yield* countSnapshots(), 1);
        })
    );

    it.effect(
      "F7: a cell closed under another definition is marked and not shown as the measure; one closed under the present definition is shown",
      () =>
        Effect.gen(function* otherDefinition() {
          const [first] = yield* world();
          yield* clearSnapshots();
          const snapshots = yield* ImpactSnapshots;

          yield* closing(snapshots, {
            definitionHash: "an older definition",
            department: Option.none(),
            semester: FIRST_ENDED,
            value: 50,
          });

          assert.deepStrictEqual(
            placementsAt(yield* impactReport("standard"), FIRST_ENDED, null),
            Released.cases.Unavailable.make({
              reason: "closed under another definition of the measure",
            })
          );

          yield* closing(snapshots, {
            definitionHash: definitionHash(
              ImpactMeasures.measureOf("placements")
            ),
            department: Option.fromNullishOr(first),
            semester: FIRST_ENDED,
            value: 45,
          });

          assert.deepStrictEqual(
            placementsAt(
              yield* impactReport("standard"),
              FIRST_ENDED,
              first ?? null
            ),
            published(45)
          );
        })
    );

    it.effect(
      "F3 and F4 through the store: a closed cell is read in place of the source, a count below five is suppressed, and the neighbour that would give it away is suppressed too",
      () =>
        Effect.gen(function* released() {
          const [a, b] = yield* world();
          yield* clearSnapshots();
          const snapshots = yield* ImpactSnapshots;

          // One department has three placements, the other fifty-seven, and all of them sixty: the sum gives the three away.
          const rows: readonly (readonly [
            Option.Option<DepartmentId>,
            number,
          ])[] = [
            [Option.none(), 60],
            [Option.fromNullishOr(a), 3],
            [Option.fromNullishOr(b), 57],
          ];

          for (const [department, value] of rows) {
            yield* closing(snapshots, {
              definitionHash: definitionHash(
                ImpactMeasures.measureOf("placements")
              ),
              department,
              semester: SECOND_ENDED,
              value,
            });
          }

          // The live source says something else: a closed cell is what is read.
          const report = yield* impactReport("standard").pipe(
            Effect.provideService(
              ImpactSource,
              sourceAnswering(() => 1000)
            )
          );

          assert.deepStrictEqual(
            placementsAt(report, SECOND_ENDED, null),
            published(60)
          );

          for (const department of [a, b]) {
            assert.strictEqual(
              placementsAt(report, SECOND_ENDED, department ?? null)?._tag,
              "Suppressed"
            );
          }

          // No published cell of the report is a count below the minimum.
          for (const cell of report.cells) {
            if (Predicate.isTagged(cell.released, "Published")) {
              assert.isTrue(
                cell.released.value === 0 ||
                  cell.released.value >= report.minimum
              );
            }
          }
        })
    );
  }
);
