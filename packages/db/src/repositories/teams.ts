/**
 * Spec 0006: people, teams, memberships, the admin list, the digest ledger and the principal directory.
 *
 * The constraints do the work that a read-then-write would race on (ADR 0007, no advisory locks):
 * - one e-mail is one person (`person_email_unique`), a team name is unique in its department,
 * - a person's memberships in one team never overlap (`membership_no_overlap`, an exclusion constraint), and
 *   `start ≤ end` is a check,
 * - a transition is a conditional update: it names the state the caller read, and a row that is no longer in that
 *   state matches nothing, which is a `Conflict`.
 * The state of a membership is calculated, never stored: the ordinals below are generated columns of the term.
 */
import {
  AdminGrant,
  AdminGrantRepository,
  Conflict,
  DepartmentId,
  DigestLedger,
  EmailAddress,
  MEMBERSHIP_CHANGED,
  Membership,
  MembershipFact,
  MembershipRepository,
  NotFound,
  Person,
  PersonId,
  PersonRepository,
  Position,
  PositionRepository,
  PrincipalDirectory,
  Team,
  TeamRepository,
  personPrincipal,
  semesterOrdinal,
} from "@vektorprogrammet/domain";
import type {
  AdminGrantId,
  MembershipId,
  PersonDraft,
  Semester,
  TeamDetails,
  TeamDraft,
  TeamId,
} from "@vektorprogrammet/domain";
import { and, asc, desc, eq, gt, gte, lte, sql } from "drizzle-orm";
import { Array as Arr, DateTime, Effect, Layer, Option, Schema } from "effect";

import { classifySqlFailure } from "../classifySqlFailure.ts";
import {
  Drizzle,
  decodeFirstOption,
  decodeWith,
  single,
} from "../internal/drizzle.ts";
import {
  adminGrant,
  endingSoonDigest,
  fieldOfStudy,
  membership,
  person,
  position,
  team,
} from "../schema.ts";

// ---------------------------------------------------------------- people

const personColumns = {
  departmentId: fieldOfStudy.departmentId,
  email: person.email,
  fieldOfStudyId: person.fieldOfStudyId,
  id: person.id,
  name: person.name,
};

export const PersonRepositoryLive = Layer.effect(
  PersonRepository,
  Effect.gen(function* PersonRepositoryLive() {
    const db = yield* Drizzle;
    const decode = decodeWith(Person);
    const decodeAll = decodeWith(Schema.Array(Person));

    const joined = () =>
      db
        .select(personColumns)
        .from(person)
        .innerJoin(fieldOfStudy, eq(person.fieldOfStudyId, fieldOfStudy.id));

    const findById = Effect.fn("PersonRepository.findById")(function* findById(
      id: PersonId
    ) {
      const [row] = yield* joined().where(eq(person.id, id)).pipe(Effect.orDie);

      return row === undefined
        ? yield* new NotFound({ entity: "Person", key: String(id) })
        : yield* decode(row);
    });

    const list = Effect.fn("PersonRepository.list")(function* list(
      departmentId: DepartmentId | null
    ) {
      const rows = yield* joined()
        .where(
          departmentId === null
            ? undefined
            : eq(fieldOfStudy.departmentId, departmentId)
        )
        .orderBy(asc(person.name), asc(person.id))
        .pipe(Effect.orDie);

      return yield* decodeAll(rows);
    });

    const create = Effect.fn("PersonRepository.create")(function* create(
      draft: PersonDraft
    ) {
      const rows = yield* db
        .insert(person)
        .values(draft)
        .returning({ id: person.id })
        .pipe(Effect.catch((error) => classifySqlFailure(error, draft.email)));

      const created = yield* single(rows);

      return yield* Effect.orDie(findById(PersonId.make(created.id)));
    });

    return PersonRepository.of({ create, findById, list });
  })
);

// ---------------------------------------------------------------- teams and positions

export const TeamRepositoryLive = Layer.effect(
  TeamRepository,
  Effect.gen(function* TeamRepositoryLive() {
    const db = yield* Drizzle;
    const decode = decodeWith(Team);
    const decodeAll = decodeWith(Schema.Array(Team));

    const teamById = (id: TeamId, rows: readonly unknown[]) => {
      const [row] = rows;

      return row === undefined
        ? Effect.fail(new NotFound({ entity: "Team", key: String(id) }))
        : decode(row);
    };

    const findById = Effect.fn("TeamRepository.findById")(function* findById(
      id: TeamId
    ) {
      const rows = yield* db
        .select()
        .from(team)
        .where(eq(team.id, id))
        .pipe(Effect.orDie);

      return yield* teamById(id, rows);
    });

    const list = Effect.fn("TeamRepository.list")(function* list(
      departmentId: DepartmentId | null
    ) {
      const rows = yield* db
        .select()
        .from(team)
        .where(
          departmentId === null
            ? undefined
            : eq(team.departmentId, departmentId)
        )
        .orderBy(asc(team.name), asc(team.id))
        .pipe(Effect.orDie);

      return yield* decodeAll(rows);
    });

    const create = Effect.fn("TeamRepository.create")(function* create(
      draft: TeamDraft
    ) {
      const rows = yield* db
        .insert(team)
        .values(draft)
        .returning()
        .pipe(Effect.catch((error) => classifySqlFailure(error, draft.name)));

      return yield* decode(yield* single(rows));
    });

    const update = Effect.fn("TeamRepository.update")(function* update(
      id: TeamId,
      details: TeamDetails
    ) {
      const rows = yield* db
        .update(team)
        .set(details)
        .where(eq(team.id, id))
        .returning()
        .pipe(Effect.catch((error) => classifySqlFailure(error, details.name)));

      return yield* teamById(id, rows);
    });

    const deactivate = Effect.fn("TeamRepository.deactivate")(
      function* deactivate(id: TeamId) {
        const rows = yield* db
          .update(team)
          .set({ active: false })
          .where(eq(team.id, id))
          .returning()
          .pipe(Effect.orDie);

        return yield* teamById(id, rows);
      }
    );

    return TeamRepository.of({ create, deactivate, findById, list, update });
  })
);

export const PositionRepositoryLive = Layer.effect(
  PositionRepository,
  Effect.gen(function* PositionRepositoryLive() {
    const db = yield* Drizzle;
    const decode = decodeWith(Position);
    const decodeAll = decodeWith(Schema.Array(Position));

    const findById = Effect.fn("PositionRepository.findById")(
      function* findById(id: Position["id"]) {
        const [row] = yield* db
          .select()
          .from(position)
          .where(eq(position.id, id))
          .pipe(Effect.orDie);

        return row === undefined
          ? yield* new NotFound({ entity: "Position", key: String(id) })
          : yield* decode(row);
      }
    );

    return PositionRepository.of({
      findById,
      list: db
        .select()
        .from(position)
        .orderBy(asc(position.name))
        .pipe(
          Effect.orDie,
          Effect.flatMap(decodeAll),
          Effect.withSpan("PositionRepository.list")
        ),
    });
  })
);

// ---------------------------------------------------------------- memberships

const membershipColumns = {
  endTerm: membership.endTerm,
  endYear: membership.endYear,
  id: membership.id,
  leader: membership.leader,
  personId: membership.personId,
  positionId: membership.positionId,
  startTerm: membership.startTerm,
  startYear: membership.startYear,
  teamId: membership.teamId,
};

interface MembershipRow {
  readonly endTerm: Semester["term"];
  readonly endYear: number;
  readonly id: number;
  readonly leader: boolean;
  readonly personId: number;
  readonly positionId: number;
  readonly startTerm: Semester["term"];
  readonly startYear: number;
  readonly teamId: number;
}

/** A row's columns as the domain's `Membership` has them: the term is a start and an end semester. */
const termOf = (row: MembershipRow) => ({
  end: { term: row.endTerm, year: row.endYear },
  id: row.id,
  leader: row.leader,
  personId: row.personId,
  positionId: row.positionId,
  start: { term: row.startTerm, year: row.startYear },
  teamId: row.teamId,
});

const MembershipView = Schema.Struct({
  ...Membership.fields,
  personName: Schema.String,
  positionName: Schema.String,
});

const ActiveMembership = Schema.Struct({
  ...Membership.fields,
  departmentId: DepartmentId,
  personEmail: EmailAddress,
  personName: Schema.String,
  positionName: Schema.String,
  teamName: Schema.String,
});

const lostRace = (id: MembershipId) =>
  new Conflict({
    entity: "Membership",
    key: String(id),
    message: MEMBERSHIP_CHANGED,
  });

export const MembershipRepositoryLive = Layer.effect(
  MembershipRepository,
  Effect.gen(function* MembershipRepositoryLive() {
    const db = yield* Drizzle;
    const decode = decodeWith(Membership);
    const decodeViews = decodeWith(Schema.Array(MembershipView));
    const decodeActive = decodeWith(Schema.Array(ActiveMembership));

    const named = () =>
      db
        .select({
          ...membershipColumns,
          personName: person.name,
          positionName: position.name,
        })
        .from(membership)
        .innerJoin(person, eq(membership.personId, person.id))
        .innerJoin(position, eq(membership.positionId, position.id));

    const findById = Effect.fn("MembershipRepository.findById")(
      function* findById(id: MembershipId) {
        const [row] = yield* db
          .select(membershipColumns)
          .from(membership)
          .where(eq(membership.id, id))
          .pipe(Effect.orDie);

        return row === undefined
          ? yield* new NotFound({ entity: "Membership", key: String(id) })
          : yield* decode(termOf(row));
      }
    );

    const listByTeam = Effect.fn("MembershipRepository.listByTeam")(
      function* listByTeam(teamId: TeamId) {
        const rows = yield* named()
          .where(eq(membership.teamId, teamId))
          .orderBy(asc(membership.startOrdinal), asc(membership.id))
          .pipe(Effect.orDie);

        return yield* decodeViews(
          Arr.map(rows, (row) => ({
            ...termOf(row),
            personName: row.personName,
            positionName: row.positionName,
          }))
        );
      }
    );

    const listByPerson = Effect.fn("MembershipRepository.listByPerson")(
      function* listByPerson(personId: PersonId) {
        const rows = yield* named()
          .where(eq(membership.personId, personId))
          .orderBy(desc(membership.startOrdinal), desc(membership.id))
          .pipe(Effect.orDie);

        return yield* decodeViews(
          Arr.map(rows, (row) => ({
            ...termOf(row),
            personName: row.personName,
            positionName: row.positionName,
          }))
        );
      }
    );

    const activeIn = Effect.fn("MembershipRepository.activeIn")(
      function* activeIn(semester: Semester) {
        const ordinal = semesterOrdinal(semester);

        const rows = yield* db
          .select({
            ...membershipColumns,
            departmentId: team.departmentId,
            personEmail: person.email,
            personName: person.name,
            positionName: position.name,
            teamName: team.name,
          })
          .from(membership)
          .innerJoin(person, eq(membership.personId, person.id))
          .innerJoin(position, eq(membership.positionId, position.id))
          .innerJoin(team, eq(membership.teamId, team.id))
          .where(
            and(
              lte(membership.startOrdinal, ordinal),
              gte(membership.endOrdinal, ordinal)
            )
          )
          .orderBy(asc(team.name), asc(person.name), asc(membership.id))
          .pipe(Effect.orDie);

        return yield* decodeActive(
          Arr.map(rows, (row) => ({
            ...termOf(row),
            departmentId: row.departmentId,
            personEmail: row.personEmail,
            personName: row.personName,
            positionName: row.positionName,
            teamName: row.teamName,
          }))
        );
      }
    );

    const insert = Effect.fn("MembershipRepository.insert")(function* insert(
      draft: Omit<Membership, "id">
    ) {
      const rows = yield* db
        .insert(membership)
        .values({
          endTerm: draft.end.term,
          endYear: draft.end.year,
          leader: draft.leader,
          personId: draft.personId,
          positionId: draft.positionId,
          startTerm: draft.start.term,
          startYear: draft.start.year,
          teamId: draft.teamId,
        })
        .returning(membershipColumns)
        .pipe(
          Effect.catch((error) =>
            classifySqlFailure(error, String(draft.personId))
          )
        );

      return yield* decode(termOf(yield* single(rows)));
    });

    /**
     * `UPDATE … SET end = $new WHERE id = $1 AND end = $observed AND start ≤ current AND current ≤ end`: the
     * membership is Active in `activeIn` and still ends where the caller read it, or the update matches nothing.
     */
    const setEnd = Effect.fn("MembershipRepository.setEnd")(
      function* setEnd(change: {
        readonly id: MembershipId;
        readonly observedEnd: Semester;
        readonly newEnd: Semester;
        readonly activeIn: Semester;
      }) {
        const current = semesterOrdinal(change.activeIn);

        const rows = yield* db
          .update(membership)
          .set({ endTerm: change.newEnd.term, endYear: change.newEnd.year })
          .where(
            and(
              eq(membership.id, change.id),
              eq(membership.endOrdinal, semesterOrdinal(change.observedEnd)),
              lte(membership.startOrdinal, current),
              gte(membership.endOrdinal, current)
            )
          )
          .returning(membershipColumns)
          .pipe(
            Effect.catch((error) =>
              classifySqlFailure(error, String(change.id))
            )
          );

        const [row] = rows;

        return row === undefined
          ? yield* lostRace(change.id)
          : yield* decode(termOf(row));
      }
    );

    /** `DELETE … WHERE id = $1 AND term = $observed AND start > current`: only a membership that has not started. */
    const remove = Effect.fn("MembershipRepository.remove")(
      function* remove(removal: {
        readonly id: MembershipId;
        readonly observed: Pick<Membership, "end" | "start">;
        readonly current: Semester;
      }) {
        const rows = yield* db
          .delete(membership)
          .where(
            and(
              eq(membership.id, removal.id),
              eq(
                membership.startOrdinal,
                semesterOrdinal(removal.observed.start)
              ),
              eq(membership.endOrdinal, semesterOrdinal(removal.observed.end)),
              gt(membership.startOrdinal, semesterOrdinal(removal.current))
            )
          )
          .returning({ id: membership.id })
          .pipe(Effect.orDie);

        if (rows.length === 0) {
          return yield* lostRace(removal.id);
        }

        return yield* Effect.void;
      }
    );

    return MembershipRepository.of({
      activeIn,
      findById,
      insert,
      listByPerson,
      listByTeam,
      remove,
      setEnd,
    });
  })
);

// ---------------------------------------------------------------- the admin list

const StoredAdminGrant = Schema.Struct({
  ...AdminGrant.fields,
  until: Schema.DateTimeUtcFromDate,
});

const StoredAdminGrantView = Schema.Struct({
  ...StoredAdminGrant.fields,
  personName: Schema.String,
});

export const AdminGrantRepositoryLive = Layer.effect(
  AdminGrantRepository,
  Effect.gen(function* AdminGrantRepositoryLive() {
    const db = yield* Drizzle;
    const decode = decodeWith(StoredAdminGrant);
    const decodeViews = decodeWith(Schema.Array(StoredAdminGrantView));

    const findById = Effect.fn("AdminGrantRepository.findById")(
      function* findById(id: AdminGrantId) {
        const [row] = yield* db
          .select()
          .from(adminGrant)
          .where(eq(adminGrant.id, id))
          .pipe(Effect.orDie);

        return row === undefined
          ? yield* new NotFound({ entity: "AdminGrant", key: String(id) })
          : yield* decode(row);
      }
    );

    const create = Effect.fn("AdminGrantRepository.create")(function* create(
      draft: Omit<AdminGrant, "id">
    ) {
      const rows = yield* db
        .insert(adminGrant)
        .values({ ...draft, until: DateTime.toDateUtc(draft.until) })
        .returning()
        .pipe(Effect.orDie);

      return yield* decode(yield* single(rows));
    });

    /**
     * The places that end after `validAfter` are locked in id order first, so two revocations at once queue up,
     * and the second one sees the first one's result: the last valid place is never removed.
     */
    const revoke = Effect.fn("AdminGrantRepository.revoke")(function* revoke(
      id: AdminGrantId,
      validAfter: DateTime.Utc
    ) {
      const target = yield* findById(id);

      const valid = yield* db
        .select({ id: adminGrant.id })
        .from(adminGrant)
        .where(gt(adminGrant.until, DateTime.toDateUtc(validAfter)))
        .orderBy(asc(adminGrant.id))
        .for("update")
        .pipe(Effect.orDie);

      if (
        DateTime.isGreaterThan(target.until, validAfter) &&
        valid.length === 1 &&
        valid[0]?.id === id
      ) {
        return "last" as const;
      }

      const removed = yield* db
        .delete(adminGrant)
        .where(eq(adminGrant.id, id))
        .returning({ id: adminGrant.id })
        .pipe(Effect.orDie);

      return removed.length === 0
        ? yield* new NotFound({ entity: "AdminGrant", key: String(id) })
        : ("revoked" as const);
    });

    return AdminGrantRepository.of({
      create,
      findById,
      list: db
        .select({
          grantedBy: adminGrant.grantedBy,
          id: adminGrant.id,
          personId: adminGrant.personId,
          personName: person.name,
          until: adminGrant.until,
        })
        .from(adminGrant)
        .innerJoin(person, eq(adminGrant.personId, person.id))
        .orderBy(desc(adminGrant.until), asc(adminGrant.id))
        .pipe(
          Effect.orDie,
          Effect.flatMap(decodeViews),
          Effect.withSpan("AdminGrantRepository.list")
        ),
      revoke,
    });
  })
);

// ---------------------------------------------------------------- the digest ledger

export const DigestLedgerLive = Layer.effect(
  DigestLedger,
  Effect.gen(function* DigestLedgerLive() {
    const db = yield* Drizzle;

    /** `INSERT … ON CONFLICT DO NOTHING RETURNING`: a row comes back only for the first caller. */
    const claim = Effect.fn("DigestLedger.claim")(function* claim(
      personId: PersonId,
      semester: Semester
    ) {
      const rows = yield* db
        .insert(endingSoonDigest)
        .values({
          personId,
          recordedAt: DateTime.toDateUtc(yield* DateTime.now),
          term: semester.term,
          year: semester.year,
        })
        .onConflictDoNothing()
        .returning({ personId: endingSoonDigest.personId })
        .pipe(Effect.orDie);

      return rows.length > 0;
    });

    return DigestLedger.of({ claim });
  })
);

// ---------------------------------------------------------------- the principal directory

/** What one read of a person returns: the active memberships and the end of every admin place, as JSON. */
const Facts = Schema.Struct({
  id: PersonId,
  memberships: Schema.Array(MembershipFact),
  placeEnds: Schema.Array(Schema.DateTimeUtcFromString),
});

export const PrincipalDirectoryLive = Layer.effect(
  PrincipalDirectory,
  Effect.gen(function* PrincipalDirectoryLive() {
    const db = yield* Drizzle;
    const decodeFacts = decodeFirstOption(decodeWith(Facts));

    const byName = Effect.fn("PrincipalDirectory.byName")(function* byName(
      name: string,
      at: { readonly current: Semester; readonly now: DateTime.Utc }
    ) {
      const ordinal = semesterOrdinal(at.current);

      const rows = yield* db
        .select({
          id: person.id,
          memberships: sql`coalesce((
            select json_agg(json_build_object(
              'departmentId', ${team.departmentId},
              'function', ${team.function},
              'leader', ${membership.leader},
              'teamId', ${team.id}
            ))
            from ${membership}
            inner join ${team} on ${team.id} = ${membership.teamId}
            where ${membership.personId} = ${person.id}
              and ${membership.startOrdinal} <= ${ordinal}
              and ${membership.endOrdinal} >= ${ordinal}
          ), '[]'::json)`,
          placeEnds: sql`coalesce((
            select json_agg(${adminGrant.until})
            from ${adminGrant}
            where ${adminGrant.personId} = ${person.id}
          ), '[]'::json)`,
        })
        .from(person)
        .where(eq(person.name, name))
        .orderBy(asc(person.id))
        .limit(1)
        .pipe(Effect.orDie);

      return Option.map(yield* decodeFacts(rows), (facts) =>
        personPrincipal({
          memberships: facts.memberships,
          now: at.now,
          personId: facts.id,
          placeEnds: facts.placeEnds,
        })
      );
    });

    const names = Effect.fn("PrincipalDirectory.names")(function* names(
      limit: number
    ) {
      const rows = yield* db
        .selectDistinct({ name: person.name })
        .from(person)
        .orderBy(asc(person.name))
        .limit(limit)
        .pipe(Effect.orDie);

      return Arr.map(rows, (row) => row.name);
    });

    return PrincipalDirectory.of({ byName, names });
  })
);
