/**
 * What the personal data tests of spec 0007b share: who acts (a person for themselves, an administrator), a program run as
 * an actor in a transaction of its own, the merge as an administrator's command, and which rows still name a person.
 */
import {
  CurrentPrincipal,
  PersonId,
  PersonalDataEndpoints,
  Principal,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Record as Rec, Struct } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { transactional } from "../../src/index.ts";

/** An administrator's place that never ends, as far as a test can tell. */
const FAR = DateTime.makeUnsafe("2099-01-01T00:00:00Z");

/** A signed-in person with no administrator place: someone who acts on their own data. */
export const selfPrincipal = (personId: number) =>
  Principal.cases.Person.make({
    memberships: [],
    personId: PersonId.make(personId),
  });

/** A person whose administrator place has no end in sight. */
export const adminPrincipal = (personId: number) =>
  Principal.cases.Person.make({
    adminUntil: FAR,
    memberships: [],
    personId: PersonId.make(personId),
  });

/** Runs a program as `actor`, in a transaction of its own. */
export const runAs = <A, E, R>(
  actor: Principal,
  program: Effect.Effect<A, E, R>
) => transactional(Effect.provideService(program, CurrentPrincipal, actor));

/** `admin` merges the record `from` into the record `into`. */
export const mergeAs = (admin: number, into: number, from: number) =>
  runAs(
    adminPrincipal(admin),
    PersonalDataEndpoints.mergePersons({ from, into })
  );

/** How many rows of `table` the SQL condition `where` selects. */
export const countWhere = Effect.fnUntraced(function* countWhere(
  table: string,
  where: string
) {
  const sql = yield* SqlClient;

  const [row] = yield* sql.unsafe<{ n: number }>(
    `select count(*)::int as n from ${table} where ${where}`
  );

  return row?.n ?? 0;
});

/** How each table that can name a person does it: the condition that selects the rows of the person with this id. */
const naming = {
  account: (id: number) => `person_id = ${id}`,
  admin_grant: (id: number) => `person_id = ${id}`,
  alumni_request: (id: number) => `person_id = ${id}`,
  audit_log: (id: number) => `person_id = ${id}`,
  auth_account: (id: number) =>
    `user_id in (select id from auth_user where person_id = ${id})`,
  auth_session: (id: number) =>
    `user_id in (select id from auth_user where person_id = ${id})`,
  auth_user: (id: number) => `person_id = ${id}`,
  code: (id: number) => `subject = ${id}`,
  consent: (id: number) => `person_id = ${id}`,
  ending_soon_digest: (id: number) => `person_id = ${id}`,
  membership: (id: number) => `person_id = ${id}`,
  public_file: (id: number) => `uploaded_by = ${id}`,
} as const;

type NamingTable = keyof typeof naming;

/** Every table that can name a person. */
export const NAMING_TABLES = Struct.keys(naming);

/**
 * The tables among `tables` that still have rows naming the person, and how many. A table with none is left out, so
 * `{}` says that nothing names them.
 */
export const rowsNaming = Effect.fnUntraced(function* rowsNaming(
  personId: number,
  tables: readonly NamingTable[]
) {
  const counted = yield* Effect.forEach(tables, (table) =>
    Effect.map(
      countWhere(table, naming[table](personId)),
      (rows) => [table, rows] as const
    )
  );

  const present: Partial<Record<NamingTable, number>> = Rec.fromEntries(
    Arr.filter(counted, ([, rows]) => rows > 0)
  );

  return present;
});
