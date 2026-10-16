/**
 * Maps a SQL failure to the domain's closed error set or a defect.
 *
 * Only a unique violation of a known constraint is an expected outcome
 * (`AlreadyExists`); every other failure (lost connection, check or foreign-key
 * violation, syntax, serialization) is a defect, per the repository contract in
 * `packages/domain/src/README.md`.
 *
 * The result is an `Exit`, which is an `Effect`, so a repository can write
 * `Effect.catch((failure) => classifySqlFailure(failure, key))`.
 */
import { AlreadyExists } from "@vektorprogrammet/domain";
import type { EntityName } from "@vektorprogrammet/domain";
import { Cause, Exit, Option, Predicate, Record as Rec, Schema } from "effect";
import { isSqlError } from "effect/sql/SqlError";
import type { SqlError } from "effect/sql/SqlError";

import { UniqueConstraint } from "./schema.ts";

interface UniqueOutcome {
  readonly entity: EntityName;
  /** User-facing Norwegian text; commands may replace it (RULE-144). */
  readonly message: (key: string) => string;
}

const uniqueOutcomes: Record<UniqueConstraint, UniqueOutcome> = {
  [UniqueConstraint.departmentCity]: {
    entity: "Department",
    message: (key) => `Det finnes allerede en avdeling i ${key}.`,
  },
  [UniqueConstraint.semesterTermYear]: {
    entity: "Semester",
    message: (key) => `Semesteret ${key} finnes allerede`,
  },
  [UniqueConstraint.articleSlug]: {
    entity: "Article",
    message: (key) => `Adressen ${key} er allerede i bruk.`,
  },
};

const UniqueConstraintName = Schema.Literals(Rec.values(UniqueConstraint));

const isUniqueConstraint = (name: string): name is UniqueConstraint =>
  Schema.is(UniqueConstraintName)(name);

/** Drizzle wraps driver failures (`EffectDrizzleQueryError.cause` is a `Cause`); unwrap to the `SqlError`. */
const findSqlError = (failure: unknown, depth = 0): Option.Option<SqlError> => {
  if (depth > 4) {
    return Option.none();
  }

  if (isSqlError(failure)) {
    return Option.some(failure);
  }

  if (Cause.isCause(failure)) {
    return Option.flatMap(Cause.findErrorOption(failure), (error) =>
      findSqlError(error, depth + 1)
    );
  }

  if (Predicate.hasProperty(failure, "cause")) {
    return findSqlError(failure.cause, depth + 1);
  }

  return Option.none();
};

/** The unique constraint a failure violated, if it is a unique violation. */
export const violatedUniqueConstraint = (
  failure: unknown
): Option.Option<string> =>
  Option.flatMap(findSqlError(failure), (error) =>
    Predicate.isTagged(error.reason, "UniqueViolation")
      ? Option.some(error.reason.constraint)
      : Option.none()
  );

/**
 * `AlreadyExists` for a unique violation of a known constraint (`key` is the
 * natural key that collided, as text); a defect for everything else.
 */
export const classifySqlFailure = (
  failure: unknown,
  key: string
): Exit.Exit<never, AlreadyExists> => {
  const constraint = violatedUniqueConstraint(failure);

  if (Option.isSome(constraint) && isUniqueConstraint(constraint.value)) {
    const outcome = uniqueOutcomes[constraint.value];

    return Exit.fail(
      new AlreadyExists({
        entity: outcome.entity,
        key,
        message: outcome.message(key),
      })
    );
  }

  return Exit.die(failure);
};
