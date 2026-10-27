/**
 * The relational read models: the events of the two aggregates, written into the repository's own tables
 * (`membership`, `admin_grant`, `account`) by projections. On the PostgreSQL platform a projection runs inside the
 * transaction that commits the events, so these rows are never behind the event log, and every constraint of the
 * schema (`membership_no_overlap`, the foreign keys, `admin_grant_not_self`) still holds the writes.
 *
 * Every write is idempotent: a projection runs at least once per event (`ON CONFLICT DO NOTHING`, an upsert, a delete
 * of a row that may be gone).
 */
import * as Domain from "@alchemy.run/domain";
import { PersonId } from "@vektorprogrammet/domain";
import { Effect, Match, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import {
  AccountActivated,
  AccountDeactivated,
  AccountInvited,
  AccountReactivated,
  AdminList,
  AdminPlaceGranted,
  AdminPlaceRevoked,
} from "./adminList.ts";
import {
  MembershipAdded,
  MembershipCancelled,
  MembershipEndedEarly,
  MembershipExtended,
  Person,
} from "./person.ts";

/** A `Person` instance's id is the person row's id as text. */
const personIdOfKey = Schema.decodeUnknownEffect(
  Schema.FiniteFromString.pipe(Schema.decodeTo(PersonId))
);

export class MembershipRows extends Domain.Projection("MembershipRows", {
  from: [Person],
  key: Person,
  on: [
    MembershipAdded,
    MembershipExtended,
    MembershipEndedEarly,
    MembershipCancelled,
  ],
}) {}

export const MembershipRowsLive = MembershipRows.toLayer(
  Effect.gen(function* membershipRowsLive() {
    const sql = yield* SqlClient;

    return Effect.fnUntraced(function* apply(batch) {
      for (const { event, key } of batch) {
        yield* Match.value(event).pipe(
          Match.tagsExhaustive({
            MembershipAdded: (added) =>
              Effect.flatMap(
                personIdOfKey(key.id),
                (personId) =>
                  sql`insert into membership
                    (id, person_id, team_id, position_id, leader, start_term, start_year, end_term, end_year)
                    values (${added.id}, ${personId}, ${added.teamId}, ${added.positionId}, ${added.leader},
                      ${added.start.term}, ${added.start.year}, ${added.end.term}, ${added.end.year})
                    on conflict (id) do nothing`
              ),
            MembershipCancelled: (cancelled) =>
              sql`delete from membership where id = ${cancelled.id}`,
            MembershipEndedEarly: (ended) =>
              sql`update membership set end_term = ${ended.end.term}, end_year = ${ended.end.year}
                  where id = ${ended.id}`,
            MembershipExtended: (extended) =>
              sql`update membership set end_term = ${extended.end.term}, end_year = ${extended.end.year}
                  where id = ${extended.id}`,
          })
        );
      }
    }, Effect.orDie);
  })
);

export class AdminRows extends Domain.Projection("AdminRows", {
  from: [AdminList],
  key: AdminList,
  on: [
    AdminPlaceGranted,
    AdminPlaceRevoked,
    AccountInvited,
    AccountActivated,
    AccountDeactivated,
    AccountReactivated,
  ],
}) {}

const accountState = (sql: SqlClient, personId: number, state: string) =>
  sql`insert into alchemy_admin_account (person_id, state) values (${personId}, ${state})
    on conflict (person_id) do update set state = excluded.state`;

export const AdminRowsLive = AdminRows.toLayer(
  Effect.gen(function* adminRowsLive() {
    const sql = yield* SqlClient;

    return Effect.fnUntraced(function* apply(batch) {
      for (const { event } of batch) {
        yield* Match.value(event).pipe(
          Match.tagsExhaustive({
            AccountActivated: ({ personId }) =>
              accountState(sql, personId, "Active"),
            AccountDeactivated: ({ personId }) =>
              accountState(sql, personId, "Deactivated"),
            AccountInvited: ({ personId }) =>
              accountState(sql, personId, "Invited"),
            AccountReactivated: ({ personId }) =>
              accountState(sql, personId, "Active"),
            AdminPlaceGranted: (granted) =>
              sql`insert into alchemy_admin_place (id, person_id, granted_by, until)
                  values (${granted.id}, ${granted.personId}, ${granted.grantedBy}, ${granted.until.toJSON()})
                  on conflict (id) do nothing`,
            AdminPlaceRevoked: (revoked) =>
              sql`delete from alchemy_admin_place where id = ${revoked.id}`,
          })
        );
      }
    }, Effect.orDie);
  })
);
