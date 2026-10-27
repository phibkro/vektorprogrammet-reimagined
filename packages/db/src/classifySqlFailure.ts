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
import {
  AlreadyExists,
  MEMBERSHIP_OVERLAPS,
  PERSON_EXISTS,
  TEAM_EXISTS,
} from "@vektorprogrammet/domain";
import type { EntityName } from "@vektorprogrammet/domain";
import {
  Cause,
  Exit,
  Match,
  Option,
  Predicate,
  Record as Rec,
  Schema,
} from "effect";
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
  [UniqueConstraint.membershipOverlap]: {
    entity: "Membership",
    message: () => MEMBERSHIP_OVERLAPS,
  },
  [UniqueConstraint.personEmail]: {
    entity: "Person",
    message: () => PERSON_EXISTS,
  },
  [UniqueConstraint.personCompanyEmail]: {
    entity: "Person",
    message: () => PERSON_EXISTS,
  },
  [UniqueConstraint.semesterTermYear]: {
    entity: "Semester",
    message: (key) => `Semesteret ${key} finnes allerede`,
  },
  [UniqueConstraint.teamGroupEmail]: {
    entity: "Team",
    message: () => "Gruppeadressen er allerede brukt av et annet team.",
  },
  [UniqueConstraint.teamName]: {
    entity: "Team",
    message: () => TEAM_EXISTS,
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

/** SQLSTATE of an exclusion violation; the driver reports it as a plain `ConstraintError` with the driver's error as `cause`. */
const EXCLUSION_VIOLATION = "23P01";

const exclusionConstraintOf = (reason: {
  readonly cause?: unknown;
}): Option.Option<string> => {
  const { cause } = reason;

  return Predicate.hasProperty(cause, "code") &&
    cause.code === EXCLUSION_VIOLATION &&
    Predicate.hasProperty(cause, "constraint") &&
    Predicate.isString(cause.constraint)
    ? Option.some(cause.constraint)
    : Option.none();
};

/** The unique or exclusion constraint a failure violated, if it is such a violation. */
export const violatedUniqueConstraint = (
  failure: unknown
): Option.Option<string> =>
  Option.flatMap(findSqlError(failure), (error) =>
    Match.value(error.reason).pipe(
      Match.tag("UniqueViolation", ({ constraint }) => Option.some(constraint)),
      Match.tag("ConstraintError", exclusionConstraintOf),
      Match.orElse(() => Option.none())
    )
  );

/** Whether a failure is the database refusing a row: a unique, exclusion, check, foreign-key or not-null violation. */
export const isConstraintViolation = (failure: unknown): boolean =>
  Option.exists(
    findSqlError(failure),
    ({ reason }) =>
      Predicate.isTagged(reason, "UniqueViolation") ||
      Predicate.isTagged(reason, "ConstraintError")
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
