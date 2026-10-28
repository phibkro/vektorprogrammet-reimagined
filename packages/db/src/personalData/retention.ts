/**
 * The retention rules of the catalog and the early expiry of one person's data, as statements (spec 0007b). Both read
 * the same rules and run the same `apply`; they differ in which rows they select. The nightly run selects the rows
 * whose period is over at `now`. An erasure selects every row of the person, in the tables that declare `Expire`.
 *
 * The nightly run also exists as a report (`personalDataRetentionReport`): the same selections through the same traversal,
 * counted and not changed, with no lock and no writer to change a row through. Which of the two a deployment gets is
 * decided in `apps/web` (spec 0007b R4).
 *
 * A rule runs per person, under the person's lock, when it writes a table the Person root owns, reads last activity, or
 * deletes a child that would otherwise cascade from a parent. The lock keeps another command from changing the person
 * between the decision and the write. Owned rows use `Aggregates` and the chunk's tokens, in ascending id order. Other
 * rules use conditional bulk statements, in chunks of rows.
 */
import { Catalog, retentionRules } from "@vektorprogrammet/domain";
import type {
  AggregateLocks,
  CatalogOf,
  Counts,
  InTransaction,
  Locked,
  RetentionRule,
} from "@vektorprogrammet/domain";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  Array as Arr,
  DateTime,
  Effect,
  Match,
  Number as Num,
  Option,
  Order,
  Predicate,
  Record as Rec,
  Schema,
} from "effect";

import type { Aggregates } from "../aggregate/aggregates.ts";
import { roots } from "../aggregate/declaration.ts";
import type { Root } from "../aggregate/model.ts";
import type { Drizzle } from "../internal/drizzle.ts";
import { peopleDue, readPeople } from "./activity.ts";
import { tally } from "./counts.ts";
import { photosOf, releasePhotos } from "./photos.ts";
import {
  aboutPeople,
  allOf,
  anonymisedValue,
  col,
  expiredAt,
  identifier,
  personIn,
  personOf,
} from "./sql.ts";
import type { ActivityDue } from "./sql.ts";
import { cascadesVia, ownedBy, propertyOf, tableOf } from "./tables.ts";

const PERSON_CHUNK = 100;
const BULK_CHUNK = 1000;

const catalog: CatalogOf = Catalog;
const personRoot: Root<"Person"> = roots.Person;

const decodeCount = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ n: Schema.Int })])
);

const decodeCandidates = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.Int }))
);

type Tokens = readonly Locked<"Person">[];

type Written = readonly (readonly [string, number])[];

/** A rule and the rules whose deletion cascades to its rows, derived once from declarations and schema. */
interface PlannedRule {
  readonly rule: RetentionRule;
  readonly cascadeParents: readonly RetentionRule[];
}

const findCascadeParents = (
  rule: RetentionRule,
  rules: readonly RetentionRule[]
) => {
  const { key } = rule;

  return Predicate.isTagged(key, "Via") && cascadesVia(rule.table, key)
    ? Arr.filter(
        rules,
        (parent) => parent.table === key.parent && parent.expiry === "Delete"
      )
    : [];
};

/** Cascading children run before their parent under the person lock, so each deleted row is counted once. */
const runsPerPerson = ({
  rule,
  cascadeParents: parents,
}: PlannedRule): boolean =>
  rule.key !== null &&
  !Predicate.isTagged(rule.key, "Address") &&
  (parents.length > 0 ||
    Option.isSome(ownedBy(rule.table)) ||
    Predicate.isTagged(rule.retention.trigger, "LastActivityEnd"));

/**
 * The order of the rules for one person. Last-activity rules come before membership and admin-place deletion, so those
 * deletes cannot move the activity date first. `partition` puts a cascading child before its parent as well.
 */
const order = Order.combineAll<RetentionRule>([
  Order.mapInput(Order.Number, (rule) =>
    Predicate.isTagged(rule.retention.trigger, "LastActivityEnd") ? 0 : 1
  ),
  Order.mapInput(Order.Number, (rule) =>
    Predicate.isTagged(rule.key, "Via") ? 0 : 1
  ),
  Order.mapInput(Order.String, (rule) => rule.table),
]);

/** The tables a run reports, each once, with nothing changed yet. */
const nothingChanged = (selected: readonly RetentionRule[]): Counts =>
  Rec.fromEntries(Arr.map(selected, (rule) => [rule.table, 0] as const));

/** A row that an anonymising rule has not reached yet. */
const notAnonymised = (rule: RetentionRule): SQL | undefined =>
  rule.expiry === "Anonymise" && rule.marker !== undefined
    ? sql`${col(rule.table, rule.marker)} is null`
    : undefined;

/** The rules of a run, by where each runs: per person under their lock, or in bulk. */
const partition = (rules: readonly RetentionRule[]) => {
  const planned = Arr.map(rules, (rule): PlannedRule => ({
    cascadeParents: findCascadeParents(rule, rules),
    rule,
  }));

  const childFirst = Order.combine(
    Order.mapInput(Order.Number, (item: PlannedRule) =>
      item.cascadeParents.length > 0 ? 0 : 1
    ),
    Order.mapInput(order, (item: PlannedRule) => item.rule)
  );

  return {
    inBulk: Arr.map(
      Arr.filter(planned, (item) => !runsPerPerson(item)),
      (item) => item.rule
    ),
    perPerson: Arr.sort(Arr.filter(planned, runsPerPerson), childFirst),
  };
};

/** The rows of a rule that have expired at `now` and are not anonymised yet. */
const dueAt = (
  rule: RetentionRule,
  now: DateTime.Utc,
  activity: ActivityDue
): SQL => allOf(expiredAt(rule, now, activity), notAnonymised(rule));

/** No rule is decided by a person's facts: a bulk rule, which has no person, and the search for candidates, which reads the facts itself. */
const noOne: ActivityDue = () => sql`false`;

/** A rule whose period starts when the person's last activity ends. */
const startsAtLastActivity = (rule: RetentionRule): boolean =>
  Predicate.isTagged(rule.retention.trigger, "LastActivityEnd");

/** The rows of a rule whose person is one of the people whom the domain says are due, from their facts. */
const activityOf =
  (people: Parameters<typeof peopleDue>[0], now: DateTime.Utc): ActivityDue =>
  (rule) =>
    rule.key === null
      ? sql`false`
      : personIn(personOf(rule.table, rule.key), peopleDue(people, rule, now));

/** A child is also due when deleting its parent cascades to it, even if the child's own period has not ended. */
const plannedDueAt = (
  { rule, cascadeParents }: PlannedRule,
  now: DateTime.Utc,
  activity: ActivityDue
): SQL => {
  const { key } = rule;

  if (!Predicate.isTagged(key, "Via") || cascadeParents.length === 0) {
    return dueAt(rule, now, activity);
  }

  const throughParent = Arr.map(
    cascadeParents,
    (parent) =>
      sql`${col(rule.table, key.column)} in (select ${col(key.parent, key.parentKey)} from ${identifier(key.parent)} where ${dueAt(parent, now, activity)})`
  );

  return sql`(${sql.join([dueAt(rule, now, activity), ...throughParent], sql` or `)})`;
};

/**
 * The rows of a per-person rule that a nightly run changes for these people: due at `now`, and theirs. The run that
 * changes them and the run that counts them select with this one expression.
 */
const dueForPeople = (
  planned: PlannedRule,
  key: NonNullable<RetentionRule["key"]>,
  now: DateTime.Utc,
  ids: readonly number[],
  activity: ActivityDue
): SQL =>
  allOf(
    plannedDueAt(planned, now, activity),
    aboutPeople(planned.rule.table, key, { addresses: [], ids })
  );

/** How many rows `where` selects in the rule's table: a read, and the whole of what a report does to a rule. */
const countRows = (
  db: Drizzle["Service"],
  rule: RetentionRule,
  where: SQL
): Effect.Effect<number> =>
  db
    .execute<{ n: number }>(
      sql`select count(*)::int as n from ${identifier(rule.table)} where ${where}`,
      "objects"
    )
    .pipe(
      Effect.flatMap(decodeCount),
      Effect.map(([row]) => row.n),
      Effect.orDie
    );

/**
 * The people who have a row that has expired, in ascending id order: from the rows' own columns for most rules, and from
 * the people's facts for a rule that starts at their last activity.
 */
const candidates = Effect.fnUntraced(function* candidates(
  db: Drizzle["Service"],
  perPerson: readonly PlannedRule[],
  now: DateTime.Utc
) {
  const fromActivity = Arr.filter(perPerson, ({ rule }) =>
    startsAtLastActivity(rule)
  );

  const fromRows = Arr.filter(
    perPerson,
    ({ rule }) => !startsAtLastActivity(rule)
  );

  const rowSelects = Arr.flatMap(fromRows, (planned) => {
    const { rule } = planned;

    return rule.key === null
      ? []
      : [
          sql`select ${personOf(rule.table, rule.key)} as id from ${identifier(rule.table)} where ${plannedDueAt(planned, now, noOne)}`,
        ];
  });

  const decided = Arr.isReadonlyArrayNonEmpty(rowSelects)
    ? yield* db
        .execute<{ id: number }>(
          sql`select distinct id from (${sql.join(rowSelects, sql` union `)}) as candidate where id in (select id from person where merged_into is null) order by id`,
          "objects"
        )
        .pipe(
          Effect.flatMap(decodeCandidates),
          Effect.map((found) => Arr.map(found, ({ id }) => id)),
          Effect.orDie
        )
    : [];

  // A rule that starts at the person's last activity is decided from facts: the people who still hold a row it has not
  // reached, among those whose period the domain says has ended. A tombstone has none: its rows moved.
  const decidedByFacts = Arr.isReadonlyArrayNonEmpty(fromActivity)
    ? yield* Effect.gen(function* byFacts() {
        const people = yield* readPeople(db, sql`p.merged_into is null`);

        return yield* Effect.forEach(fromActivity, ({ rule }) =>
          rule.key === null
            ? Effect.succeed([])
            : Effect.map(
                db
                  .execute<{ id: number }>(
                    sql`select distinct ${personOf(rule.table, rule.key)} as id from ${identifier(rule.table)} where ${allOf(notAnonymised(rule), sql`${personOf(rule.table, rule.key)} is not null`)}`,
                    "objects"
                  )
                  .pipe(Effect.flatMap(decodeCandidates), Effect.orDie),
                (holders) =>
                  Arr.intersection(
                    Arr.map(holders, ({ id }) => id),
                    peopleDue(people, rule, now)
                  )
              )
        );
      })
    : [];

  return Arr.sort(
    Arr.dedupe([...decided, ...Arr.flatten(decidedByFacts)]),
    Order.Number
  );
});

/** What a nightly run does with the rows that its rules select: change them through the people's locks, or count them. */
interface Run {
  /** The people of a chunk that the run goes on with, and the tokens that it changes their rows through (none, if it changes nothing). */
  readonly people: (
    ids: readonly number[]
  ) => Effect.Effect<
    { readonly ids: readonly number[]; readonly tokens: Tokens },
    never,
    InTransaction
  >;
  /** A per-person rule over the rows that `where` selects: how many rows. */
  readonly rows: (
    rule: RetentionRule,
    where: SQL,
    tokens: Tokens,
    now: DateTime.Utc
  ) => Effect.Effect<number>;
  /** A bulk rule over every row that has expired at `now`: how many rows. */
  readonly bulk: (
    rule: RetentionRule,
    now: DateTime.Utc
  ) => Effect.Effect<number>;
}

/**
 * The nightly run over `rules`: who has an expired row, then each chunk of them through `run.people` and every per-person
 * rule in order, then the bulk rules. The selections are the same whatever `run` does with them, so a run that counts
 * says how many rows a run that changes would have changed.
 */
const nightly = (
  db: Drizzle["Service"],
  rules: readonly RetentionRule[],
  run: Run
) => {
  const { inBulk, perPerson } = partition(rules);

  /** The rules, in order, for one chunk of people: the facts of the people are read after `run.people` has locked them. */
  const forPeople = Effect.fnUntraced(function* forPeople(
    chunk: readonly number[],
    now: DateTime.Utc
  ) {
    const { ids, tokens } = yield* run.people(chunk);
    const nothing: Written = [];

    if (!Arr.isReadonlyArrayNonEmpty(ids)) {
      return nothing;
    }

    const activity = activityOf(
      Arr.some(perPerson, ({ rule }) => startsAtLastActivity(rule))
        ? yield* readPeople(db, personIn(col("p", "id"), ids))
        : [],
      now
    );

    return yield* Effect.forEach(perPerson, (planned) => {
      const { rule } = planned;

      return Effect.map(
        rule.key === null
          ? Effect.succeed(0)
          : run.rows(
              rule,
              dueForPeople(planned, rule.key, now, ids, activity),
              tokens,
              now
            ),
        (rows) => [rule.table, rows] as const
      );
    });
  });

  return Effect.fn("RetentionRun.run")(function* nightlyRun(now: DateTime.Utc) {
    const people = yield* candidates(db, perPerson, now);

    const perChunk = yield* Effect.forEach(
      Arr.chunksOf(people, PERSON_CHUNK),
      (ids) => forPeople(ids, now)
    );

    const swept = yield* Effect.forEach(inBulk, (rule) =>
      Effect.map(run.bulk(rule, now), (rows) => [rule.table, rows] as const)
    );

    return tally(nothingChanged(rules), [...Arr.flatten(perChunk), ...swept]);
  });
};

/**
 * The retention and the erasure of the catalog. `rules` are the rules that a run applies: all of the catalog's, unless a
 * test builds a store that leaves one out, to show that the table-driven test then fails.
 */
export const personalDataRetention = (
  services: {
    readonly aggregates: Aggregates["Service"];
    readonly db: Drizzle["Service"];
    readonly locks: AggregateLocks["Service"];
  },
  rules: readonly RetentionRule[] = retentionRules(catalog)
) => {
  const { aggregates, db, locks } = services;

  /** The rules that erasure runs: the tables whose person relation declares `Expire`. */
  const erasing = Arr.sort(
    Arr.filter(rules, (rule) =>
      Option.exists(
        Rec.get(catalog, rule.table).pipe(
          Option.flatMapNullishOr((declaration) => declaration.person?.erase)
        ),
        (erase) => Predicate.isTagged(erase, "Expire")
      )
    ),
    order
  );

  const remove = Effect.fnUntraced(function* remove(
    rule: RetentionRule,
    where: SQL,
    tokens: Tokens
  ) {
    const owned = ownedBy(rule.table);

    if (Option.isSome(owned)) {
      const rows = yield* aggregates
        .remove(tokens, owned.value, where)
        .pipe(Effect.orDie);

      return rows.length;
    }

    const table = yield* tableOf(rule.table);

    const rows = yield* db
      .delete(table)
      .where(where)
      .returning({ one: sql`1` })
      .pipe(Effect.orDie);

    return rows.length;
  });

  const anonymise = Effect.fnUntraced(function* anonymise(
    rule: RetentionRule,
    where: SQL,
    tokens: Tokens,
    now: DateTime.Utc
  ) {
    const table = yield* tableOf(rule.table);

    const markerEntries =
      rule.marker === undefined
        ? []
        : [[propertyOf(table, rule.marker), DateTime.toDateUtc(now)] as const];

    const set = Rec.fromEntries([
      ...Arr.map(
        Rec.toEntries(rule.anonymised),
        ([column, to]) =>
          [propertyOf(table, column), anonymisedValue(rule.table, to)] as const
      ),
      ...markerEntries,
    ]);

    // A person's photo goes with the person: the keys are read before the statement that clears them.
    const keys = rule.table === "person" ? yield* photosOf(db, where) : [];

    const rows =
      rule.table === "person"
        ? yield* aggregates
            .updateRoot(tokens, personRoot, set, where)
            .pipe(Effect.orDie)
        : yield* db
            .update(table)
            .set(set)
            .where(where)
            .returning({ one: sql`1` })
            .pipe(Effect.orDie);

    yield* releasePhotos(db, keys, now);

    return rows.length;
  });

  /** One rule over the rows that `where` selects: the rows are deleted or anonymised, and the count comes back. */
  const apply = (
    rule: RetentionRule,
    where: SQL,
    tokens: Tokens,
    now: DateTime.Utc
  ): Effect.Effect<number> =>
    Match.value(rule.expiry).pipe(
      Match.when("Delete", () => remove(rule, where, tokens)),
      Match.when("Anonymise", () => anonymise(rule, where, tokens, now)),
      Match.exhaustive
    );

  /** Deletes a table's expired rows a chunk at a time, until a chunk comes back short. */
  const sweep = (
    rule: RetentionRule,
    now: DateTime.Utc
  ): Effect.Effect<number> =>
    Effect.gen(function* sweepChunk() {
      const chunk = sql`ctid = any(array(select ctid from ${identifier(rule.table)} where ${dueAt(rule, now, noOne)} limit ${BULK_CHUNK}))`;
      const rows = yield* apply(rule, chunk, [], now);

      return rows < BULK_CHUNK ? rows : rows + (yield* sweep(rule, now));
    });

  /** Locks the people that still exist: a person who was merged since they were found has no lock to take. */
  const lockLive = (
    ids: readonly number[]
  ): Effect.Effect<Tokens, never, InTransaction> =>
    locks
      .lockAll("Person", ids)
      .pipe(
        Effect.catchTag("NotFound", ({ key }) =>
          lockLive(Arr.filter(ids, (id) => String(id) !== key))
        )
      );

  /** The nightly run: every rule at `now`, per person under their lock, then the bulk statements. */
  const expire = nightly(db, rules, {
    bulk: sweep,
    people: (ids) =>
      Effect.map(lockLive(ids), (tokens) => ({
        ids: Arr.map(tokens, ({ id }) => id),
        tokens,
      })),
    rows: apply,
  });

  /** The addresses the person is known by, read before an erasure changes them. */
  const addressesOf = (id: number): Effect.Effect<readonly string[]> =>
    db
      .execute<{ address: string }>(
        sql`select lower(email) as address from person where id = ${id}
          union select lower(company_email) from person where id = ${id} and company_email is not null
          union select lower(email) from auth_user where person_id = ${id}`,
        "objects"
      )
      .pipe(
        Effect.map((found) => Arr.map(found, ({ address }) => address)),
        Effect.orDie
      );

  /** The early expiry of the locked person's data: each table that declares `Expire` runs its rule for this person now. */
  const erase = Effect.fn("PersonalDataStore.erase")(function* erase(
    locked: Locked<"Person">
  ) {
    const addresses = yield* addressesOf(locked.id);
    const now = yield* DateTime.now;

    const written = yield* Effect.forEach(erasing, (rule) =>
      Effect.map(
        rule.key === null
          ? Effect.succeed(0)
          : apply(
              rule,
              allOf(
                aboutPeople(rule.table, rule.key, {
                  addresses,
                  ids: [locked.id],
                }),
                notAnonymised(rule)
              ),
              [locked],
              now
            ),
        (rows) => [rule.table, rows] as const
      )
    );

    return tally(nothingChanged(erasing), written);
  });

  /** The person's own row, anonymised: what a merge leaves of the merged person (their other rows moved). */
  const anonymisePerson = (
    locked: Locked<"Person">,
    now: DateTime.Utc
  ): Effect.Effect<number> =>
    Effect.map(
      Effect.forEach(
        Arr.filter(erasing, (rule) => rule.table === "person"),
        (rule) =>
          apply(
            rule,
            allOf(
              sql`${col("person", "id")} = ${locked.id}`,
              notAnonymised(rule)
            ),
            [locked],
            now
          )
      ),
      Num.sumAll
    );

  return { anonymisePerson, erase, expire };
};

/**
 * The nightly run as a report: the selections of `personalDataRetention`, counted and not changed. It takes the database
 * and nothing else, so it has no lock and no aggregate writer to change a row through, and its statements are
 * `count(*)` and the read that finds the people (spec 0007b R4). A test runs it as a role that can only read.
 */
export const personalDataRetentionReport = (
  db: Drizzle["Service"],
  rules: readonly RetentionRule[] = retentionRules(catalog)
) => ({
  expire: nightly(db, rules, {
    bulk: (rule, now) => countRows(db, rule, dueAt(rule, now, noOne)),
    people: (ids) => Effect.succeed({ ids, tokens: [] }),
    rows: (rule, where) => countRows(db, rule, where),
  }),
});
