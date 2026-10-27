/**
 * Reusable semester checks for machine contexts. A check is an Effect Schema filter; its representation is the
 * data from which a later compiler can recover the operation and its operand paths. The runtime and the revivers
 * use the same constructors, so the persisted check and its interpretation cannot diverge.
 */
import {
  Array as Arr,
  Option,
  Predicate,
  Schema,
  SchemaRepresentation,
} from "effect";
import type { SchemaAST } from "effect";

import { Semester, SemesterOrder } from "../organisation/semester.ts";
import type { Semester as SemesterValue } from "../organisation/semester.ts";

const AFTER = "vektorprogrammet/semester/after";
const SAME = "vektorprogrammet/semester/same";
const NOT = "vektorprogrammet/semester/not";
const OR = "vektorprogrammet/semester/or";

/**
 * The ids of the checks that this module builds: the closed vocabulary of a machine's guards. The effx export
 * (`effx.ts`) translates exactly these, so a new id is a decision there and not a silent default.
 */
export const ids = { after: AFTER, not: NOT, or: OR, same: SAME } as const;

/** Paths to semesters in this context, including semesters nested in one struct. */
export type SemesterPath<Context> = {
  readonly [Key in keyof Context & string]: Context[Key] extends SemesterValue
    ? readonly [Key]
    : {
        readonly [
          Nested in keyof Context[Key] & string
        ]: Context[Key][Nested] extends SemesterValue
          ? readonly [Key, Nested]
          : never;
      }[keyof Context[Key] & string];
}[keyof Context & string] &
  readonly [string, ...string[]];

const Path = Schema.NonEmptyArray(Schema.String);
const Comparison = Schema.Struct({ left: Path, right: Path });

type Comparison = typeof Comparison.Type;

const isSemester = Schema.is(Semester);

const comparison = <Context>(
  id: typeof AFTER | typeof SAME,
  payload: Comparison
): SchemaAST.Filter<Context> =>
  Schema.makeFilter<Context>(
    (context) => {
      const select = (
        path: readonly string[]
      ): Option.Option<SemesterValue> => {
        let value: unknown = context;

        for (const key of path) {
          if (!Predicate.isObject(value)) {
            return Option.none();
          }

          value = value[key];
        }

        return isSemester(value) ? Option.some(value) : Option.none();
      };

      const left = select(payload.left);
      const right = select(payload.right);

      if (Option.isNone(left) || Option.isNone(right)) {
        return false;
      }

      const order = SemesterOrder(left.value, right.value);

      return id === AFTER ? order > 0 : order === 0;
    },
    {
      expected: `${Arr.join(payload.left, ".")} ${id === AFTER ? "after" : "same as"} ${Arr.join(payload.right, ".")}`,
      representation: { id, payload },
    }
  );

const hasOneOperand = Schema.is(Schema.Tuple([Schema.Unknown]));
const hasOperands = Schema.is(Schema.NonEmptyArray(Schema.Unknown));

/** The native schema checks in `schemas` are the represented operands of a logical filter. */
const logical = (
  id: typeof NOT | typeof OR,
  schemas: readonly Schema.Top[]
) => {
  const valid = id === NOT ? hasOneOperand(schemas) : hasOperands(schemas);

  const predicates = Arr.map(schemas, Schema.is);

  return Schema.makeFilter(
    (input) =>
      valid &&
      (id === NOT
        ? !Arr.every(predicates, (predicate) => predicate(input))
        : Arr.some(predicates, (predicate) => predicate(input))),
    {
      expected:
        id === NOT ? "not the nested check" : "at least one nested check",
      representation: {
        id,
        payload: null,
        schemas: Arr.map(schemas, (schema) => schema.ast),
      },
    }
  );
};

/** Build typed semester comparisons and logical checks for a single machine's context schema. */
export const semesters = <Context>(context: Schema.Schema<Context>) => ({
  after: (
    left: SemesterPath<Context>,
    right: SemesterPath<Context>
  ): SchemaAST.Filter<Context> => comparison(AFTER, { left, right }),
  not: (check: SchemaAST.Check<Context>): SchemaAST.Filter<Context> =>
    logical(NOT, [context.check(check)]),
  or: (
    ...checks: readonly [
      SchemaAST.Check<Context>,
      ...SchemaAST.Check<Context>[],
    ]
  ): SchemaAST.Filter<Context> =>
    logical(
      OR,
      Arr.map(checks, (check) => context.check(check))
    ),
  same: (
    left: SemesterPath<Context>,
    right: SemesterPath<Context>
  ): SchemaAST.Filter<Context> => comparison(SAME, { left, right }),
});

/**
 * A check as a sentence, and how it joins others: `not (…)` and a single comparison stand alone, `and` and `or` do
 * not, so a longer sentence wraps them where they would read both ways.
 */
interface Sentence {
  readonly joint: "all" | "any" | "single";
  readonly text: string;
}

/** A sentence inside a longer one that joins in the other way, wrapped. */
const within = (sentence: Sentence, other: Sentence["joint"]): string =>
  sentence.joint === other ? `(${sentence.text})` : sentence.text;

/** Sentences that all hold: one is itself, several are joined by `and`. */
const allOf = (sentences: readonly Sentence[]): Sentence => {
  const [only, ...others] = sentences;

  if (only === undefined) {
    return { joint: "single", text: "condition" };
  }

  return Arr.isReadonlyArrayEmpty(others)
    ? only
    : {
        joint: "all",
        text: Arr.join(
          Arr.map(sentences, (sentence) => within(sentence, "any")),
          " and "
        ),
      };
};

/** Sentences of which one holds: one is itself, several are joined by `or`. */
const anyOf = (sentences: readonly Sentence[]): Sentence => {
  const [only, ...others] = sentences;

  if (only === undefined) {
    return { joint: "single", text: "condition" };
  }

  return Arr.isReadonlyArrayEmpty(others)
    ? only
    : {
        joint: "any",
        text: Arr.join(
          Arr.map(sentences, (sentence) => within(sentence, "all")),
          " or "
        ),
      };
};

const sentenceOf = (check: SchemaAST.Check<never>): Sentence => {
  const expected = check.annotations?.expected;

  if (Predicate.isTagged(check, "FilterGroup")) {
    return expected === undefined
      ? allOf(Arr.map(check.checks, sentenceOf))
      : { joint: "single", text: expected };
  }

  const representation = check.annotations?.representation;

  // the checks of an operand hold together, as the checks of a schema do
  const operands = Arr.map(representation?.schemas ?? [], (ast) =>
    allOf(Arr.map(ast.checks ?? [], sentenceOf))
  );

  const [only, ...others] = operands;

  if (
    representation?.id === NOT &&
    only !== undefined &&
    Arr.isReadonlyArrayEmpty(others)
  ) {
    return { joint: "single", text: `not (${only.text})` };
  }

  return representation?.id === OR && only !== undefined
    ? anyOf(operands)
    : { joint: "single", text: expected ?? "condition" };
};

/**
 * A diagram label for a check without a separately declared label. It is the check, said in words, down to its
 * operands: `not (term.start after current)`, `a or b`, `(a and b) or c`. The label of a change that time makes is
 * always this, so that it cannot say something other than its guard.
 */
export const describe = (check: SchemaAST.Check<never>): string =>
  sentenceOf(check).text;

/** Revivers of the closed check vocabulary, including Effect's checks on semester years. */
export const revivers = [
  SchemaRepresentation.isIntReviver,
  SchemaRepresentation.isBetweenReviver,
  SchemaRepresentation.makeReviverFilter(AFTER, Comparison, ({ payload }) =>
    comparison(AFTER, payload)
  ),
  SchemaRepresentation.makeReviverFilter(SAME, Comparison, ({ payload }) =>
    comparison(SAME, payload)
  ),
  SchemaRepresentation.makeReviverFilter(NOT, Schema.Null, ({ schemas }) =>
    logical(NOT, schemas)
  ),
  SchemaRepresentation.makeReviverFilter(OR, Schema.Null, ({ schemas }) =>
    logical(OR, schemas)
  ),
] as const;
