import { assert, layer } from "@effect/vitest";
import { Array as Arr, Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { violatedUniqueConstraint } from "../../src/adapters/db/classifySqlFailure.ts";
import { Conflict, ValidationFailed } from "../../src/core/errors";
import { SiteOrigin } from "../../src/core/siteOrigin";
import { PersonalDataEndpoints } from "../../src/features/personal-data/domain/commands";
import { TeamsEndpoints } from "../../src/features/teams/domain/commands";
import {
  MembershipRepository,
  TeamRepository,
} from "../../src/features/teams/domain/services";
import { postgresDatabase } from "./support/database.ts";
import { failedWith } from "./support/failures.ts";
import { adminPrincipal, runAs } from "./support/personalDataActors.ts";
import { meetsHeldLock, race, raceReport, raceTwo } from "./support/race.ts";
import {
  asPerson,
  freshMembership,
  placeMembership,
  semester,
  twoPeople,
  world,
} from "./support/teamsWorld.ts";

const controlRollback = new Conflict({
  entity: "Person",
  key: "spec0032-control",
  message: "Rollback disposable schema control.",
});

const START = semester("HOST", 2026);
const END = semester("VAR", 2027);
const LATER = semester("HOST", 2027);

const MEMBERSHIP_TERM = { end: END, start: START };

const database = Layer.merge(
  postgresDatabase(),
  Layer.succeed(SiteOrigin)("https://vektorprogrammet.test")
);

/** Raw writers deliberately bypass the port; the index must protect them too. */
const point = Effect.fnUntraced(function* point(from: number, into: number) {
  const sql = yield* SqlClient;

  return yield* sql`update person set merged_into = ${into}, anonymised_at = now() where id = ${from}`;
});

/** A Team waiter must already have completed the Person FOR NO KEY UPDATE query. */
const personHeldAtTeamWait = Effect.gen(function* personHeldAtTeamWait() {
  const sql = yield* SqlClient;

  const [row] = yield* sql<{ held: boolean }>`select exists (
    select 1 from pg_stat_activity a join pg_locks l on l.pid = a.pid
    where a.datname = current_database() and a.pid <> pg_backend_pid()
      and a.wait_event_type = 'Lock' and a.query ilike '%for share%'
      and l.locktype = 'relation' and l.relation = 'person'::regclass
      and l.mode = 'RowShareLock' and l.granted
  ) as held`;

  return row?.held === true;
});

layer(database, { excludeTestServices: true })(
  "spec 0032: real lifecycle invariants",
  (it) => {
    it.effect(
      "F4: an anonymised record cannot be merged into or from, with no changed references",
      () =>
        Effect.gen(function* erasedMerge() {
          const sql = yield* SqlClient;
          const found = yield* world("lc-erased-merge");

          const [a, b] = yield* twoPeople(
            found.fieldOfStudy.id,
            "lc-erased-merge-pair"
          );

          yield* sql`update person set anonymised_at = now() where id = ${a.id}`;

          for (const [from, into] of [
            [a.id, b.id],
            [b.id, a.id],
          ]) {
            const exit = yield* Effect.exit(
              runAs(
                adminPrincipal(found.person.id),
                PersonalDataEndpoints.mergePersons({ from, into })
              )
            );

            assert.isTrue(failedWith(exit, Conflict));
          }

          const rows = yield* sql<{
            merged_into: number | null;
          }>`select merged_into from person where id in (${a.id}, ${b.id})`;

          assert.isTrue(Arr.every(rows, (row) => row.merged_into === null));
        })
    );

    it.effect(
      "F5: raw mutual merge is refused, but one-way merges and chains remain legal",
      () =>
        Effect.gen(function* rawPair() {
          const sql = yield* SqlClient;
          const found = yield* world("lc-raw");
          const [a, b] = yield* twoPeople(found.fieldOfStudy.id, "lc-raw-pair");
          yield* point(a.id, b.id);
          const refused = yield* Effect.exit(point(b.id, a.id));
          assert.isTrue(Exit.isFailure(refused));

          if (Exit.isFailure(refused)) {
            assert.deepStrictEqual(
              violatedUniqueConstraint(refused.cause),
              Option.some("person_merge_pair_unique")
            );
          }

          yield* point(b.id, found.person.id);

          const edges = yield* sql<{
            n: number;
          }>`select count(*)::int as n from person where id in (${a.id}, ${b.id}) and merged_into is not null`;

          assert.strictEqual(edges[0]?.n, 2);
        })
    );

    it.effect(
      "F5 negative control: without only the pair index, the same mutual merge commits past every older constraint",
      () =>
        Effect.gen(function* rawControl() {
          const sql = yield* SqlClient;
          const found = yield* world("lc-control");

          const [a, b] = yield* twoPeople(
            found.fieldOfStudy.id,
            "lc-control-pair"
          );

          const control = yield* Effect.exit(
            sql.withTransaction(
              Effect.gen(function* withoutIndex() {
                yield* sql`drop index person_merge_pair_unique`;
                yield* point(a.id, b.id);
                yield* point(b.id, a.id);

                const [row] = yield* sql<{
                  mutual: boolean;
                }>`select exists(select 1 from person a join person b on a.merged_into = b.id and b.merged_into = a.id where a.id = ${a.id}) as mutual`;

                assert.isTrue(row?.mutual);

                const rebuild = yield* Effect.exit(
                  sql.withTransaction(
                    sql`create unique index person_merge_pair_unique on person (least(id, merged_into), greatest(id, merged_into)) where merged_into is not null`
                  )
                );

                assert.isTrue(Exit.isFailure(rebuild));

                const [unchanged] = yield* sql<{
                  mutual: boolean;
                }>`select exists(select 1 from person a join person b on a.merged_into = b.id and b.merged_into = a.id where a.id = ${a.id}) as mutual`;

                assert.deepStrictEqual(unchanged, row);

                // Roll back the schema surgery and the forbidden pair even if a later assertion defects.
                return yield* controlRollback;
              })
            )
          );

          assert.isTrue(failedWith(control, Conflict));
          yield* point(a.id, b.id);
          const restored = yield* Effect.exit(point(b.id, a.id));
          assert.isTrue(Exit.isFailure(restored));
        })
    );

    it.effect(
      "F5: opposing raw writers have exactly one winner in 300 fresh rounds",
      () =>
        Effect.gen(function* rawRaces() {
          const found = yield* world("lc-raw-races");

          for (const round of Arr.range(1, 300)) {
            const [a, b] = yield* twoPeople(
              found.fieldOfStudy.id,
              `lc-raw-${round}`
            );

            const exits = yield* race([point(a.id, b.id), point(b.id, a.id)]);
            const report = raceReport(round, exits);
            assert.strictEqual(
              Arr.filter(exits, Exit.isSuccess).length,
              1,
              report
            );

            for (const exit of exits) {
              if (Exit.isFailure(exit)) {
                assert.deepStrictEqual(
                  violatedUniqueConstraint(exit.cause),
                  Option.some("person_merge_pair_unique"),
                  report
                );
              }
            }
          }
        })
    );

    it.effect(
      "F6: inactive teams refuse extension but allow early end, planned cancellation and a move away",
      () =>
        Effect.gen(function* inactiveExits() {
          const found = yield* freshMembership("lc-inactive", MEMBERSHIP_TERM);
          const actor = adminPrincipal(found.person.id);
          const teams = yield* TeamRepository;
          const memberships = yield* MembershipRepository;
          yield* runAs(
            actor,
            TeamsEndpoints.deactivateTeam({ id: found.team.id })
          );

          const refused = yield* Effect.exit(
            runAs(
              actor,
              TeamsEndpoints.extendMembership({
                end: LATER,
                id: found.membership.id,
              })
            )
          );

          assert.isTrue(failedWith(refused, ValidationFailed));
          assert.deepStrictEqual(
            (yield* memberships.findById(found.membership.id)).end,
            END
          );

          const ended = yield* runAs(
            actor,
            TeamsEndpoints.endEarlyMembership({
              id: found.membership.id,
              semester: END,
            })
          );

          assert.deepStrictEqual(ended.end, START);

          const planned = yield* placeMembership(
            {
              personId: found.person.id,
              positionId: found.memberPosition,
              teamId: found.team.id,
            },
            { end: LATER, start: LATER }
          );

          yield* runAs(
            actor,
            TeamsEndpoints.deleteMembership({ id: planned.id })
          );
          assert.isTrue(
            Exit.isFailure(yield* Effect.exit(memberships.findById(planned.id)))
          );

          const moving = yield* freshMembership("lc-away", MEMBERSHIP_TERM);

          const target = yield* runAs(
            adminPrincipal(moving.person.id),
            TeamsEndpoints.createTeam({
              defaultTerm: 2,
              departmentId: moving.department.id,
              function: "recruitment",
              groupEmail: null,
              name: "Active destination",
            })
          );

          yield* teams.deactivate(moving.team.id);
          yield* runAs(
            adminPrincipal(moving.person.id),
            TeamsEndpoints.changeMembership({
              from: END,
              id: moving.membership.id,
              teamId: target.id,
            })
          );
        })
    );

    it.effect(
      "F6 SQL probe: shared admissions coexist, but deactivation waits for their transaction",
      () =>
        Effect.gen(function* shareCompatibility() {
          const found = yield* world("lc-share-compatible");

          const [a, b] = yield* twoPeople(
            found.fieldOfStudy.id,
            "lc-share-compatible-pair"
          );

          const teams = yield* TeamRepository;
          const first = asPerson(a.id, () => teams.holdPresence(found.team.id));

          const compatible = yield* meetsHeldLock(
            first,
            "%for share%",
            asPerson(b.id, () => teams.holdPresence(found.team.id))
          );

          assert.strictEqual(compatible.waiting, 0);
          assert.isFalse(compatible.stillRunning);
          assert.isTrue(Exit.isSuccess(compatible.exit));

          const writer = yield* meetsHeldLock(
            first,
            "%update%team%",
            runAs(
              adminPrincipal(found.person.id),
              TeamsEndpoints.deactivateTeam({ id: found.team.id })
            )
          );

          assert.strictEqual(writer.waiting, 1);
          assert.isTrue(writer.stillRunning);
          assert.isTrue(Exit.isSuccess(writer.exit));
        })
    );

    it.effect(
      "F6 SQL probe: create and move-to wait for Team after Person, before any membership write",
      () =>
        Effect.gen(function* presenceWaiters() {
          const sql = yield* SqlClient;
          const memberships = yield* MembershipRepository;

          for (const kind of ["create", "move"] as const) {
            const found = yield* freshMembership(
              `lc-presence-${kind}`,
              MEMBERSHIP_TERM
            );

            const command =
              kind === "create"
                ? TeamsEndpoints.createMembership({
                    end: LATER,
                    leader: false,
                    personId: found.person.id,
                    positionId: found.memberPosition,
                    start: LATER,
                    teamId: found.team.id,
                  }).pipe(Effect.asVoid)
                : TeamsEndpoints.changeMembership({
                    from: END,
                    id: found.membership.id,
                    teamId: found.team.id,
                  }).pipe(Effect.asVoid);

            const result = yield* meetsHeldLock(
              sql`update team set active = false where id = ${found.team.id}`,
              "%for share%",
              runAs(adminPrincipal(found.person.id), command),
              personHeldAtTeamWait
            );

            assert.strictEqual(result.waiting, 1, kind);
            assert.deepStrictEqual(result.wrote, [], kind);
            assert.isTrue(result.during, kind);
            assert.isTrue(failedWith(result.exit, ValidationFailed), kind);
            assert.deepStrictEqual(
              (yield* memberships.findById(found.membership.id)).end,
              END
            );
            assert.lengthOf(
              yield* memberships.listByPerson(found.person.id),
              1
            );
          }
        })
    );

    it.effect(
      "F6: extension waits behind team deactivation and sees Inactive before any membership write",
      () =>
        Effect.gen(function* extendWaits() {
          const sql = yield* SqlClient;
          const found = yield* freshMembership("lc-wait", MEMBERSHIP_TERM);

          const result = yield* meetsHeldLock(
            sql`update team set active = false where id = ${found.team.id}`,
            "%for share%",
            runAs(
              adminPrincipal(found.person.id),
              TeamsEndpoints.extendMembership({
                end: LATER,
                id: found.membership.id,
              })
            )
          );

          assert.strictEqual(result.waiting, 1);
          assert.deepStrictEqual(result.wrote, []);
          assert.isTrue(failedWith(result.exit, ValidationFailed));
          assert.deepStrictEqual(
            (yield* (yield* MembershipRepository).findById(found.membership.id))
              .end,
            END
          );
        })
    );

    it.effect(
      "F6: deactivate versus extend stays serial in 300 fresh rounds",
      () =>
        Effect.gen(function* extendRaces() {
          const sql = yield* SqlClient;

          for (const round of Arr.range(1, 300)) {
            const found = yield* freshMembership(
              `lc-extend-${round}`,
              MEMBERSHIP_TERM
            );

            const actor = adminPrincipal(found.person.id);

            const exits = yield* raceTwo(
              runAs(
                actor,
                TeamsEndpoints.deactivateTeam({ id: found.team.id })
              ),
              runAs(
                actor,
                TeamsEndpoints.extendMembership({
                  end: LATER,
                  id: found.membership.id,
                })
              )
            );

            const report = raceReport<unknown, unknown>(round, exits);
            assert.isTrue(Exit.isSuccess(exits[0]), report);
            assert.isTrue(
              Exit.isSuccess(exits[1]) ||
                failedWith(exits[1], ValidationFailed),
              report
            );

            const [order] = yield* sql<{
              extendedFirst: boolean;
            }>`select coalesce((select e.id < d.id from audit_log e join audit_log d on d.entity_key = ${String(found.team.id)} and d.action = 'team.deactivated' where e.entity_key = ${String(found.membership.id)} and e.action = 'membership.extended'), true) as "extendedFirst"`;

            assert.isTrue(order?.extendedFirst, report);
          }
        })
    );
  }
);
