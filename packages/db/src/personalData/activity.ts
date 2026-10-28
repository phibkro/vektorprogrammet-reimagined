/**
 * The facts that a person's retention is decided from (spec 0021): when they were created, the end semester of each
 * membership, the end of each admin place and the consents that are current. The adapter reads them; the domain decides
 * (`lastActivityDue`, `isAlumniCandidate`). This replaces the view `person_last_activity_end`, which decided in SQL.
 */
import {
  ConsentKind,
  SemesterYear,
  Term,
  isAlumniCandidate,
  lastActivityDue,
} from "@vektorprogrammet/domain";
import type {
  ActivityFacts,
  ConsentKind as Kind,
  RetentionRule,
} from "@vektorprogrammet/domain";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Array as Arr, Effect, Option, Record as Rec, Schema } from "effect";
import type { DateTime } from "effect";

import type { Drizzle } from "../internal/drizzle.ts";

/** A person's facts, and the kinds of consent that are current for them. */
interface Person {
  readonly consents: readonly Kind[];
  readonly facts: ActivityFacts;
  readonly id: number;
}

const PersonRows = Schema.Array(
  Schema.Struct({ created_at: Schema.DateTimeUtcFromDate, id: Schema.Int })
);

const MembershipRows = Schema.Array(
  Schema.Struct({
    end_term: Term,
    end_year: SemesterYear,
    person_id: Schema.Int,
  })
);

const PlaceRows = Schema.Array(
  Schema.Struct({ person_id: Schema.Int, until: Schema.DateTimeUtcFromDate })
);

const ConsentRows = Schema.Array(
  Schema.Struct({ kind: ConsentKind, person_id: Schema.Int })
);

const RequestRows = Schema.Array(
  Schema.Struct({
    engagement_end: Schema.DateTimeUtcFromDate,
    person_id: Schema.Int,
  })
);

const read = <S extends Schema.Decoder<unknown>>(
  db: Drizzle["Service"],
  schema: S,
  statement: SQL
): Effect.Effect<S["Type"]> =>
  db
    .execute(statement, "objects")
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)), Effect.orDie);

/** The rows of each person, by the person's id. */
const byPerson = <A extends { readonly person_id: number }>(
  rows: readonly A[]
): Readonly<Record<string, readonly A[]>> =>
  Arr.groupBy(rows, ({ person_id }) => String(person_id));

const of = <A extends { readonly person_id: number }>(
  rows: Readonly<Record<string, readonly A[]>>,
  id: number
): readonly A[] => Option.getOrElse(Rec.get(rows, String(id)), () => []);

/**
 * The facts of the people that `who` selects (a condition on `person`, aliased `p`), in ascending id order: four reads. A
 * decode failure of stored data is a defect.
 */
export const readPeople = Effect.fnUntraced(function* readPeople(
  db: Drizzle["Service"],
  who: SQL
) {
  const them = sql`(select p.id from person as p where ${who})`;

  const people = yield* read(
    db,
    PersonRows,
    sql`select p.id, p.created_at from person as p where ${who} order by p.id`
  );

  const memberships = byPerson(
    yield* read(
      db,
      MembershipRows,
      sql`select person_id, end_term, end_year from membership where person_id in ${them}`
    )
  );

  const places = byPerson(
    yield* read(
      db,
      PlaceRows,
      sql`select person_id, until from admin_grant where person_id in ${them}`
    )
  );

  const consents = byPerson(
    yield* read(
      db,
      ConsentRows,
      sql`select person_id, kind from consent where withdrawn_at is null and person_id in ${them}`
    )
  );

  return Arr.map(people, ({ created_at, id }): Person => ({
    consents: Arr.map(of(consents, id), ({ kind }) => kind),
    facts: {
      createdAt: created_at,
      memberships: Arr.map(of(memberships, id), (row) => ({
        term: row.end_term,
        year: row.end_year,
      })),
      placeUntils: Arr.map(of(places, id), ({ until }) => until),
    },
    id,
  }));
});

/** The ids of the people, among those read, whose period under the rule's retention has ended at `now`. */
export const peopleDue = (
  people: readonly Person[],
  rule: Pick<RetentionRule, "retention">,
  now: DateTime.Utc
): readonly number[] => {
  const { longerWhile } = rule.retention;

  return Arr.map(
    Arr.filter(people, ({ consents, facts }) =>
      lastActivityDue(
        facts,
        rule.retention,
        longerWhile !== undefined &&
          Arr.contains(consents, longerWhile.consent),
        now
      )
    ),
    ({ id }) => id
  );
};

/** The people who have left and whom the alumni mail asks at `now`, in ascending id order (spec 0021 R5). */
export const alumniCandidates = Effect.fnUntraced(function* alumniCandidates(
  db: Drizzle["Service"],
  now: DateTime.Utc
) {
  const people = yield* readPeople(
    db,
    sql`p.anonymised_at is null and p.merged_into is null and exists (select 1 from membership as m where m.person_id = p.id)`
  );

  const requests = byPerson(
    yield* read(
      db,
      RequestRows,
      sql`select person_id, engagement_end from alumni_request where person_id in (select p.id from person as p where p.anonymised_at is null and p.merged_into is null)`
    )
  );

  return Arr.map(
    Arr.filter(people, ({ facts, id }) =>
      isAlumniCandidate(
        facts,
        Arr.map(of(requests, id), ({ engagement_end }) => engagement_end),
        now
      )
    ),
    ({ id }) => id
  );
});
