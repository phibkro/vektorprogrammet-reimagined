/**
 * The database of a runtime test: a disposable, migrated PostgreSQL, the explicit initializer for the spike's tables,
 * and one person with one membership per test, created through the real `StaffingModel`.
 *
 * The initializer is the answer to `migrate: false` in the Worker: the repository's migrations come from
 * `migratedTestDatabase`, the platform's tables from the sibling spike's `migrate` (`src/ddl.ts`) and the notice
 * table from `migrateNotices`. Only then does anything start a runtime, and the Worker checks that the tables are
 * there and fails loudly when they are not.
 */
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  migratedTestDatabase,
  TestDatabaseUrl,
} from "@vektorprogrammet/db/testing";
import {
  DepartmentRepository,
  EmailAddress,
  FieldOfStudyRepository,
  MembershipId,
  PersonRepository,
  PositionRepository,
  TeamRepository,
  advanceSemester,
  currentSemester,
} from "@vektorprogrammet/domain";
import type { PersonId, Semester, TeamId } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Layer, Random, Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { migrate as migratePlatform } from "../../../alchemy-domain/src/ddl.ts";
import {
  CommandFacts,
  RequestPrincipal,
} from "../../../alchemy-domain/src/model/context.ts";
import { factsOf } from "../../../alchemy-domain/src/model/facts.ts";
import { personKey } from "../../../alchemy-domain/src/model/ids.ts";
import {
  StaffingModel,
  staffingProjections,
} from "../../../alchemy-domain/src/model/model.ts";
import {
  CreateMembership,
  Person,
} from "../../../alchemy-domain/src/model/person.ts";
import { layer as postgresPlatform } from "../../../alchemy-domain/src/postgresPlatform.ts";
import { migrateNotices } from "../../src/notice.ts";
import { syntheticAdministrator } from "../../src/testAuthority.ts";

/** Creates the spike's tables on a database whose repository migrations are applied. The explicit initializer. */
export const initializeDatabase = Effect.gen(function* initializeDatabase() {
  const sql = yield* SqlClient;

  yield* migratePlatform;
  yield* migrateNotices;

  const [row] = yield* sql<{
    readonly present: boolean;
  }>`select to_regclass('alchemy_aggregate') is not null
        and to_regclass('spike_renewal_notice') is not null as present`;

  if (row?.present !== true) {
    return yield* Effect.die("the initializer did not create the spike tables");
  }

  return yield* Effect.void;
});

const database = Layer.unwrap(
  Effect.map(Effect.service(TestDatabaseUrl), (url) =>
    DatabaseLive({ maxConnections: 4, url })
  )
);

/**
 * The world: the migrated disposable database (`TestDatabaseUrl`), the repositories and `SqlClient`, the spike's tables
 * (created once, here), and the `Person` and `AdminList` services of the model on the PostgreSQL platform.
 */
export const world = StaffingModel.layer(staffingProjections).pipe(
  Layer.provideMerge(postgresPlatform({ migrate: false })),
  Layer.provideMerge(
    Layer.effectDiscard(initializeDatabase).pipe(Layer.provideMerge(database))
  ),
  Layer.provideMerge(migratedTestDatabase)
);

/** A person with one membership that a renewal can extend, and the strings that must never reach the engine. */
export interface Fixture {
  readonly departmentId: number;
  readonly membershipId: MembershipId;
  readonly personId: PersonId;
  readonly teamId: TeamId;
  /** The semester the membership ends in now. */
  readonly end: Semester;
  /** The semester a renewal extends it to. */
  readonly extendedEnd: Semester;
  /** Personal data of this fixture: a name, an email address and a phone number. None may appear in any engine file. */
  readonly personalData: readonly string[];
}

/** Creates a department, a person, a team and, through the model, a membership running to the next semester. */
export const newFixture = Effect.fn("world.newFixture")(function* newFixture(
  tag: string
) {
  const sql = yield* SqlClient;
  const people = yield* Person;

  const department = yield* (yield* DepartmentRepository).create({
    active: true,
    address: null,
    city: `City ${tag}`,
    email: EmailAddress.make(`${tag}@department.example`),
    latitude: null,
    logoKey: null,
    longitude: null,
    name: `Department ${tag}`,
    shortName: tag.slice(0, 3).toUpperCase(),
    slackChannel: null,
  });

  const field = yield* (yield* FieldOfStudyRepository).create({
    departmentId: department.id,
    name: `Field ${tag}`,
    shortName: tag.slice(0, 3).toUpperCase(),
  });

  const name = `Renewal Subject ${tag}`;
  const email = `renewal.subject.${tag}@person.example`;

  const person = yield* (yield* PersonRepository).create({
    email: EmailAddress.make(email),
    fieldOfStudyId: field.id,
    name,
  });

  const team = yield* (yield* TeamRepository).create({
    defaultTerm: 2,
    departmentId: department.id,
    function: "recruitment",
    name: `Team ${tag}`,
  });

  const positions = yield* (yield* PositionRepository).list;

  const member = yield* Effect.orDie(
    Effect.fromOption(
      Arr.findFirst(positions, (position) => position.name === "Medlem")
    )
  );

  const [identity] = yield* sql<{
    readonly id: number;
  }>`select nextval(pg_get_serial_sequence('membership', 'id'))::int as id`;

  if (identity === undefined) {
    return yield* Effect.die("missing membership identity");
  }

  const membershipId = MembershipId.make(identity.id);
  const current = yield* currentSemester;
  const end = advanceSemester(current, 1);

  const facts = yield* factsOf("createMembership", {
    positionId: member.id,
    target: String(person.id),
    teamId: team.id,
  });

  yield* people
    .send(
      personKey(person.id),
      new CreateMembership({
        end,
        leader: false,
        membershipId,
        positionId: member.id,
        start: current,
        teamId: team.id,
      }),
      { commandId: `fixture-create-${tag}` }
    )
    .pipe(
      Effect.provideService(
        RequestPrincipal,
        syntheticAdministrator(person.id)
      ),
      Effect.provideService(CommandFacts, facts)
    );

  return {
    departmentId: department.id,
    end,
    extendedEnd: advanceSemester(current, 2),
    membershipId,
    personId: person.id,
    personalData: [name, email, `+47 9${String(identity.id).padStart(7, "0")}`],
    teamId: team.id,
  } satisfies Fixture;
});

/** What the database holds of one renewal's command: receipts, extension events, the projected end and the notices. */
export interface Ledger {
  /** Receipts of the command id in the Person aggregate of the person. */
  readonly receipts: number;
  /** `MembershipExtended` events in that aggregate. */
  readonly extensions: number;
  /** The end of the membership row, which the model's projection writes. */
  readonly projectedEnd: Semester;
  /** Notice rows for the renewal. */
  readonly notices: number;
}

export const ledgerOf = Effect.fn("world.ledgerOf")(function* ledgerOf(
  fixture: Fixture,
  commandId: string,
  renewalId: string
) {
  const sql = yield* SqlClient;
  const aggregate = personKey(fixture.personId);

  const [receipts] = yield* sql<{
    readonly count: number;
  }>`select count(*)::int as count from alchemy_receipt
      where aggregate = 'Person' and id = ${aggregate} and command_id = ${commandId}`;

  const [extensions] = yield* sql<{
    readonly count: number;
  }>`select count(*)::int as count from alchemy_event
      where aggregate = 'Person' and id = ${aggregate} and event->>'_tag' = 'MembershipExtended'`;

  const [membership] = yield* sql<{
    readonly term: "HOST" | "VAR";
    readonly year: number;
  }>`select end_term as term, end_year as year from membership where id = ${fixture.membershipId}`;

  const [notices] = yield* sql<{
    readonly count: number;
  }>`select count(*)::int as count from spike_renewal_notice where renewal_id = ${renewalId}`;

  if (
    receipts === undefined ||
    extensions === undefined ||
    membership === undefined ||
    notices === undefined
  ) {
    return yield* Effect.die("the ledger query returned no row");
  }

  return {
    extensions: extensions.count,
    notices: notices.count,
    projectedEnd: { term: membership.term, year: membership.year },
    receipts: receipts.count,
  } satisfies Ledger;
});

/** The URL of the disposable database, which `alchemy dev` binds as its Hyperdrive origin. */
export const databaseUrl = Effect.map(
  Effect.service(TestDatabaseUrl),
  Redacted.value
);

/** A short random tag, lowercase and alphanumeric, so that ids built from it are valid renewal ids. */
export const freshTag = Effect.map(Random.nextIntBetween(0, 2 ** 31), (n) =>
  n.toString(36)
);
