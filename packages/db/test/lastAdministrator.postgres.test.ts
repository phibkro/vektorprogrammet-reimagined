import type { PgClient } from "@effect/sql-pg";
/**
 * Spec 0018, falsifier 10: the last-administrator rule (LK7) is an invariant that the store cannot express (a place
 * lapses with time), so it is port-enforced under the admin list's lock, with a named exception in the declaration. Two
 * writers stand outside the port, and neither may remove the last Active administrator: the importer and a migration.
 *
 * (a) The importer refuses a target that holds an account (`step: "protect records"`), so an Active administrator, its
 * account and its place are unchanged after a refused import. Control: a target with no account is not refused.
 * (b) The migrations are applied one at a time to a database that holds an Active administrator with a valid place, and
 * the administrator is still there after each. Control: a migration that deletes the place is found, and named.
 *
 * What a human does when the rule fails anyway (every administrator lapsed or locked out) is ADR 0011's `Emergency`
 * principal, out of band.
 */
import { assert, it } from "@effect/vitest";
import { ImportTarget } from "@vektorprogrammet/domain";
import type { TargetRows } from "@vektorprogrammet/domain";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Array as Arr, Effect, Option, Predicate, Record as Rec } from "effect";

import { ImportDatabaseLive } from "../src/index.ts";
import {
  TestDatabaseUrl,
  disposableDatabase,
  migratedTestDatabase,
  withClient,
} from "./support/disposableDatabase.ts";

const migrationsFolder = new URL("../drizzle/", import.meta.url).pathname;

/** The first migration after which an account and an admin place can be written. */
const SEEDABLE_AFTER = "20261027005012_accounts_and_sessions";

interface Step {
  readonly name: string;
  readonly statements: readonly string[];
}

/** The migrations of `drizzle/`, oldest first, as the migrator reads them (one statement per `statement-breakpoint`). */
const REAL_STEPS: readonly Step[] = Arr.map(
  readMigrationFiles({ migrationsFolder }),
  (migration) => ({ name: migration.name, statements: migration.sql })
);

const noRows: TargetRows = {
  admission_period: [],
  department: [],
  field_of_study: [],
  public_file: [],
  semester: [],
  social_event: [],
};

/** A department, a field of study, a person with an Active account and a place that is valid for ten years. */
const writeAdministrator = (client: PgClient.PgClient) =>
  Effect.gen(function* writeAdministratorRows() {
    yield* client`insert into department (id, city, email, name, short_name) values (901, 'Siste', 'siste@example.org', 'Siste', 'SIS')`;
    yield* client`insert into field_of_study (id, department_id, name, short_name) values (901, 901, 'Siste', 'SIS')`;
    yield* client`insert into person ${client.insert({ email: "siste.admin@example.org", field_of_study_id: 901, id: 901, name: "Siste Admin" })}`;
    yield* client`insert into account ${client.insert({ person_id: 901, state: "Active" })}`;
    yield* client`insert into admin_grant (person_id, until) values (901, now() + interval '10 years')`;
  });

/** How many people hold an Active account and a place that is valid now. */
const activeAdministrators = (client: PgClient.PgClient) =>
  Effect.map(
    client<{ readonly n: number }>`
      select count(distinct a.person_id)::int as n
      from account a join admin_grant g on g.person_id = a.person_id
      where a.state = 'Active' and g.until > now()`,
    (rows) => rows[0]?.n ?? 0
  );

const apply = (client: PgClient.PgClient, steps: readonly Step[]) =>
  Effect.forEach(
    Arr.flatMap(steps, (step) => step.statements),
    (statement) => client.unsafe(statement),
    { discard: true }
  );

/**
 * Applies `steps` one at a time to an empty database, writes the administrator once `SEEDABLE_AFTER` is in, and returns the
 * first migration after which no Active administrator with a valid place is left.
 */
const firstThatLosesTheAdministrator = (steps: readonly Step[]) =>
  Effect.gen(function* applyOneAtATime() {
    const url = yield* TestDatabaseUrl;

    const seedable = Arr.findFirstIndex(
      steps,
      (step) => step.name === SEEDABLE_AFTER
    );

    assert.isTrue(
      Option.isSome(seedable),
      "the migration after which the fixture is written exists"
    );

    const [before, after] = Arr.splitAt(
      steps,
      Option.getOrElse(seedable, () => 0) + 1
    );

    return yield* withClient(url, (client) =>
      Effect.gen(function* applySteps() {
        yield* apply(client, before);
        yield* writeAdministrator(client);

        for (const step of after) {
          yield* apply(client, [step]);

          if ((yield* activeAdministrators(client)) === 0) {
            return Option.some(step.name);
          }
        }

        return Option.none<string>();
      })
    );
  });

it.effect(
  "falsifier 10 (b): every migration leaves an Active administrator with a valid place where it found one",
  () =>
    Effect.gen(function* migrationsKeepTheAdministrator() {
      assert.deepStrictEqual(
        yield* firstThatLosesTheAdministrator(REAL_STEPS),
        Option.none()
      );
    }).pipe(Effect.provide(disposableDatabase))
);

it.effect(
  "falsifier 10 (b), control: a migration that deletes the place is found, and named",
  () =>
    Effect.gen(function* aMigrationThatDeletes() {
      assert.deepStrictEqual(
        yield* firstThatLosesTheAdministrator([
          ...REAL_STEPS,
          {
            name: "99990101000000_test_delete_place",
            statements: ["delete from admin_grant"],
          },
        ]),
        Option.some("99990101000000_test_delete_place")
      );
    }).pipe(Effect.provide(disposableDatabase))
);

it.effect(
  "falsifier 10 (a): the importer refuses a target that holds an administrator's account, and changes nothing",
  () =>
    Effect.gen(function* importerRefuses() {
      const url = yield* TestDatabaseUrl;
      yield* withClient(url, writeAdministrator);

      const failed = yield* Effect.flip(
        ImportTarget.use((target) => target.replaceAll(noRows)).pipe(
          Effect.provide(ImportDatabaseLive({ url }))
        )
      );

      const refusedAt = Predicate.isTagged(failed, "TargetWriteError")
        ? failed.step
        : `not a TargetWriteError: ${failed._tag}`;

      assert.strictEqual(refusedAt, "protect records");

      assert.strictEqual(
        yield* withClient(url, activeAdministrators),
        1,
        "the administrator, the account and the place are unchanged"
      );
    }).pipe(Effect.provide(migratedTestDatabase))
);

it.effect(
  "falsifier 10 (a), control: a target with no account is not refused, so the refusal is the account's",
  () =>
    Effect.gen(function* importerAcceptsWithoutAccounts() {
      const url = yield* TestDatabaseUrl;

      const counts = yield* ImportTarget.use((target) =>
        target.replaceAll(noRows)
      ).pipe(Effect.provide(ImportDatabaseLive({ url })));

      assert.isTrue(Arr.every(Rec.values(counts), (n) => n === 0));
    }).pipe(Effect.provide(migratedTestDatabase))
);
