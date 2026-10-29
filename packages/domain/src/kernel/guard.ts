/**
 * Reusable ordered-value checks for machine contexts. A check is an Effect Schema filter; its representation is the
 * data from which a later compiler can recover the operation and its operand paths. The runtime and the revivers
 * use the same constructors, so the persisted check and its interpretation cannot diverge.
 *
 * The kernel does not know what is ordered. The service that owns the value hands over its schema and its order
 * (`ordered`): `organisation/semesterGuard.ts` does it for a semester (spec 0022 R2). The ids stay the ones that the
 * descriptions already carry.
 */
import {
  Array as Arr,
  Option,
  Predicate,
  Schema,
  SchemaRepresentation,
} from "effect";
import type { Order, SchemaAST } from "effect";

/** What a guard compares: the schema that recognises the value, and the order of its values. */
export interface Ordered<Value> {
  readonly schema: Schema.Schema<Value>;
  readonly order: Order.Order<Value>;
}

const AFTER = "vektorprogrammet/semester/after";
const SAME = "vektorprogrammet/semester/same";
const NOT = "vektorprogrammet/semester/not";
const OR = "vektorprogrammet/semester/or";

/**
 * The ids of the checks that this module builds: the closed vocabulary of a machine's guards. The effx export
 * (`effx.ts`) translates exactly these, so a new id is a decision there and not a silent default.
 */
export const ids = { after: AFTER, not: NOT, or: OR, same: SAME } as const;

/** Paths to ordered values in this context, including values nested in one struct. */
export type OrderedPath<Context, Value> = {
  readonly [Key in keyof Context & string]: Context[Key] extends Value
    ? readonly [Key]
    : {
        readonly [
          Nested in keyof Context[Key] & string
        ]: Context[Key][Nested] extends Value ? readonly [Key, Nested] : never;
      }[keyof Context[Key] & string];
}[keyof Context & string] &
  readonly [string, ...string[]];

const Path = Schema.NonEmptyArray(Schema.String);
const Comparison = Schema.Struct({ left: Path, right: Path });

type Comparison = typeof Comparison.Type;

const comparison = <Context, Value>(
  value: Ordered<Value>,
  id: typeof AFTER | typeof SAME,
  payload: Comparison
): SchemaAST.Filter<Context> => {
  const isValue = Schema.is(value.schema);

  return Schema.makeFilter<Context>(
    (context) => {
      const select = (path: readonly string[]): Option.Option<Value> => {
        let found: unknown = context;

        for (const key of path) {
          if (!Predicate.isObject(found)) {
            return Option.none();
          }

          found = found[key];
        }

        return isValue(found) ? Option.some(found) : Option.none();
      };

      const left = select(payload.left);
      const right = select(payload.right);

      if (Option.isNone(left) || Option.isNone(right)) {
        return false;
      }

      const order = value.order(left.value, right.value);

      return id === AFTER ? order > 0 : order === 0;
    },
    {
      expected: `${Arr.join(payload.left, ".")} ${id === AFTER ? "after" : "same as"} ${Arr.join(payload.right, ".")}`,
      representation: { id, payload },
    }
  );
};

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

/**
 * Typed comparisons and logical checks over `value`, for a single machine's context schema, and the revivers of the
 * checks that this builds. `field` declares one of the context's ordered values for the machine (`Machine.make`'s
 * `fields`), its path typed like an operand.
 */
export const ordered = <Value>(value: Ordered<Value>) => ({
  comparisons: <Context>(context: Schema.Schema<Context>) => ({
    after: (
      left: OrderedPath<Context, Value>,
      right: OrderedPath<Context, Value>
    ): SchemaAST.Filter<Context> => comparison(value, AFTER, { left, right }),
    field: <const Kind extends string>(
      kind: Kind,
      path: OrderedPath<Context, Value>
    ) => ({ kind, path }),
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
      left: OrderedPath<Context, Value>,
      right: OrderedPath<Context, Value>
    ): SchemaAST.Filter<Context> => comparison(value, SAME, { left, right }),
  }),
  revivers: [
    SchemaRepresentation.makeReviverFilter(AFTER, Comparison, ({ payload }) =>
      comparison(value, AFTER, payload)
    ),
    SchemaRepresentation.makeReviverFilter(SAME, Comparison, ({ payload }) =>
      comparison(value, SAME, payload)
    ),
    SchemaRepresentation.makeReviverFilter(NOT, Schema.Null, ({ schemas }) =>
      logical(NOT, schemas)
    ),
    SchemaRepresentation.makeReviverFilter(OR, Schema.Null, ({ schemas }) =>
      logical(OR, schemas)
    ),
  ] as const,
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

/**
 * How sentences are joined, and what is wrapped when they are: `and` wraps an `or` among its operands and `or` wraps
 * an `and`, so that neither reads both ways.
 */
const joints = {
  all: { opposite: "any", word: " and " },
  any: { opposite: "all", word: " or " },
} as const;

/**
 * Sentences that all hold (`all`) or of which one holds (`any`): one is itself, several are joined by `and` or by `or`.
 */
const joined = (
  sentences: readonly Sentence[],
  joint: keyof typeof joints
): Sentence => {
  const [only, ...others] = sentences;

  if (only === undefined) {
    return { joint: "single", text: "condition" };
  }

  return Arr.isReadonlyArrayEmpty(others)
    ? only
    : {
        joint,
        text: Arr.join(
          Arr.map(sentences, (sentence) =>
            within(sentence, joints[joint].opposite)
          ),
          joints[joint].word
        ),
      };
};

const sentenceOf = (check: SchemaAST.Check<never>): Sentence => {
  const expected = check.annotations?.expected;

  if (Predicate.isTagged(check, "FilterGroup")) {
    return expected === undefined
      ? joined(Arr.map(check.checks, sentenceOf), "all")
      : { joint: "single", text: expected };
  }

  const representation = check.annotations?.representation;

  // the checks of an operand hold together, as the checks of a schema do
  const operands = Arr.map(representation?.schemas ?? [], (ast) =>
    joined(Arr.map(ast.checks ?? [], sentenceOf), "all")
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
    ? joined(operands, "any")
    : { joint: "single", text: expected ?? "condition" };
};

/**
 * A diagram label for a check without a separately declared label. It is the check, said in words, down to its
 * operands: `not (term.start after current)`, `a or b`, `(a and b) or c`. The label of a change that time makes is
 * always this, so that it cannot say something other than its guard.
 */
export const describe = (check: SchemaAST.Check<never>): string =>
  sentenceOf(check).text;
