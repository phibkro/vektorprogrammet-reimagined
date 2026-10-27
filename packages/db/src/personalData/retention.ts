/**
 * The retention rules of the catalog and the early expiry of one person's data, as statements (spec 0007b). Both read
 * the same rules and run the same `apply`; they differ in which rows they select. The nightly run selects the rows
 * whose period is over at `now`. An erasure selects every row of the person, in the tables that declare `Expire`.
 *
 * The nightly run also exists as a report (`personalDataRetentionReport`): the same selections through the same traversal,
 * counted and not changed, with no lock and no writer to change a row through. Which of the two a deployment gets is
 * decided in `apps/web` (spec 0007b R4).
 *
 * A rule runs per person, under the person's lock, when it writes a table that the Person root owns or reads the
 * person's last activity: the lock keeps another command from giving the person a new membership between the decision
 * and the write. The statements of a chunk of people are written through `Aggregates` and the chunk's tokens, in
 * ascending id order. Every other rule is a conditional bulk statement, in chunks of rows.
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
} from "effect";

import type { Aggregates } from "../aggregate/aggregates.ts";
import { roots } from "../aggregate/declaration.ts";
import type { Root } from "../aggregate/model.ts";
import type { Drizzle } from "../internal/drizzle.ts";
import { tally } from "./counts.ts";
import { photosOf, releasePhotos } from "./photos.ts";
import {
  aboutPeople,
  allOf,
  anonymisedValue,
  col,
  expiredAt,
  identifier,
  personOf,
} from "./sql.ts";
import { ownedBy, propertyOf, tableOf } from "./tables.ts";

const PERSON_CHUNK = 100;
const BULK_CHUNK = 1000;

const catalog: CatalogOf = Catalog;
const personRoot: Root<"Person"> = roots.Person;

type Tokens = readonly Locked<"Person">[];

type Written = readonly (readonly [string, number])[];

/** What a rule reads or writes about a person decides where it runs: per person under their lock, or in bulk. */
const runsPerPerson = (rule: RetentionRule): boolean =>
  rule.key !== null &&
  !Predicate.isTagged(rule.key, "Address") &&
  (Option.isSome(ownedBy(rule.table)) ||
    Predicate.isTagged(rule.retention.trigger, "LastActivityEnd"));

/**
 * The order of the rules for one person. The rules that read the person's last activity come first, because the rules
 * that delete a membership or an admin place (the history, kept longer) would otherwise move that date. A table that
 * reaches the person through a parent runs before the parent's table, which the rule also reads.
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

/** The rules of a run, by where each runs: per person under the person's lock, or in bulk. */
const partition = (rules: readonly RetentionRule[]) => ({
  inBulk: Arr.filter(rules, (rule) => !runsPerPerson(rule)),
  perPerson: Arr.sort(Arr.filter(rules, runsPerPerson), order),
});

/** The rows of a rule that have expired at `now` and are not anonymised yet. */
const dueAt = (rule: RetentionRule, now: DateTime.Utc): SQL =>
  allOf(expiredAt(rule, now), notAnonymised(rule));

/**
 * The rows of a per-person rule that a nightly run changes for these people: due at `now`, and theirs. The run that
 * changes them and the run that counts them select with this one expression.
 */
const dueForPeople = (
  rule: RetentionRule,
  key: NonNullable<RetentionRule["key"]>,
  now: DateTime.Utc,
  ids: readonly number[]
): SQL =>
  allOf(dueAt(rule, now), aboutPeople(rule.table, key, { addresses: [], ids }));

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
      Effect.map(([row]) => row?.n ?? 0),
      Effect.orDie
    );

/** The people who have a row that has expired, in ascending id order. A tombstone has none: its rows moved. */
const candidates = (
  db: Drizzle["Service"],
  perPerson: readonly RetentionRule[],
  now: DateTime.Utc
): Effect.Effect<readonly number[]> =>
  Arr.isReadonlyArrayNonEmpty(perPerson)
    ? db
        .execute<{ id: number }>(
          sql`select distinct id from (${sql.join(
            Arr.flatMap(perPerson, (rule) =>
              rule.key === null
                ? []
                : [
                    sql`select ${personOf(rule.table, rule.key)} as id from ${identifier(rule.table)} where ${dueAt(rule, now)}`,
                  ]
            ),
            sql` union `
          )}) as candidate where id in (select id from person where merged_into is null) order by id`,
          "objects"
        )
        .pipe(
          Effect.map((found) => Arr.map(found, ({ id }) => id)),
          Effect.orDie
        )
    : Effect.succeed([]);

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

  /** The rules, in order, for one chunk of people. */
  const forPeople = Effect.fnUntraced(function* forPeople(
    chunk: readonly number[],
    now: DateTime.Utc
  ) {
    const { ids, tokens } = yield* run.people(chunk);
    const nothing: Written = [];

    if (!Arr.isReadonlyArrayNonEmpty(ids)) {
      return nothing;
    }

    return yield* Effect.forEach(perPerson, (rule) =>
      Effect.map(
        rule.key === null
          ? Effect.succeed(0)
          : run.rows(rule, dueForPeople(rule, rule.key, now, ids), tokens, now),
        (rows) => [rule.table, rows] as const
      )
    );
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
      const chunk = sql`ctid = any(array(select ctid from ${identifier(rule.table)} where ${dueAt(rule, now)} limit ${BULK_CHUNK}))`;
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
    bulk: (rule, now) => countRows(db, rule, dueAt(rule, now)),
    people: (ids) => Effect.succeed({ ids, tokens: [] }),
    rows: (rule, where) => countRows(db, rule, where),
  }),
});
