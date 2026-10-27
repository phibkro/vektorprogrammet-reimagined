/**
 * The teams repositories. `packages/db` implements them as Layers; every method requires nothing and fails only with
 * the listed domain errors (infrastructure failures are defects). A write that must not lose a race is a conditional
 * update: it names the state the caller read, and a row that is no longer in that state is a `Conflict`.
 *
 * A table that an aggregate root owns (spec 0006b: a person owns its memberships and its admin places) is written only
 * through the owner's lock. A method that writes one takes the `Locked` token of the owner, and so does a read that
 * decides a write (`findLocked`): the command takes the lock first (`AggregateLocks`), then reads and writes through
 * the token. A read for display takes no token and locks nothing.
 */
import { Context } from "effect";
import type { DateTime, Effect, Option } from "effect";

import type { PersonPrincipal } from "../kernel/principal.ts";
import type { Semester } from "../organisation/semester.ts";
import type { Locked } from "../shared/aggregate.ts";
import type { AlreadyExists, Conflict, NotFound } from "../shared/errors.ts";
import type {
  AdminGrantId,
  DepartmentId,
  MembershipId,
  PersonId,
  TeamId,
} from "../shared/ids.ts";
import type { InTransaction } from "../shared/transaction.ts";
import type { EmailAddress } from "../shared/validation.ts";
import type {
  AdminGrant,
  AdminGrantDraft,
  Membership,
  MembershipDraft,
  Person,
  PersonDraft,
  Position,
  Team,
  TeamDetails,
  TeamDraft,
} from "./entities.ts";
import type { MembershipTerm } from "./term.ts";

/** A membership with the names a page shows beside it. */
export interface MembershipView extends Membership {
  readonly personName: string;
  readonly positionName: string;
}

/** A membership that is active in a semester, with what the "ending soon" digest needs. */
export interface ActiveMembership extends Membership {
  readonly departmentId: DepartmentId;
  readonly personEmail: EmailAddress;
  readonly personName: string;
  readonly positionName: string;
  readonly teamName: string;
}

/** A place on the admin list with the name of its holder. */
export interface AdminGrantView extends AdminGrant {
  readonly personName: string;
}

export class PersonRepository extends Context.Service<
  PersonRepository,
  {
    readonly findById: (id: PersonId) => Effect.Effect<Person, NotFound>;
    /** The locked person: a decision read, which runs after the lock and sees what no other transaction can change. */
    readonly findLocked: (locked: Locked) => Effect.Effect<Person>;
    /** The people of one department, or of all of them (`null`), by name. */
    readonly list: (
      departmentId: DepartmentId | null
    ) => Effect.Effect<readonly Person[]>;
    /** Fails with `AlreadyExists` on the unique e-mail address. */
    readonly create: (
      draft: PersonDraft
    ) => Effect.Effect<Person, AlreadyExists>;
  }
>()("@vektorprogrammet/domain/teams/PersonRepository") {}

export class TeamRepository extends Context.Service<
  TeamRepository,
  {
    readonly findById: (id: TeamId) => Effect.Effect<Team, NotFound>;
    /** The teams of one department, or of all of them (`null`), by name; deactivated ones included. */
    readonly list: (
      departmentId: DepartmentId | null
    ) => Effect.Effect<readonly Team[]>;
    /** Fails with `AlreadyExists` on the unique name within the department (RULE-157). */
    readonly create: (draft: TeamDraft) => Effect.Effect<Team, AlreadyExists>;
    readonly update: (
      id: TeamId,
      details: TeamDetails
    ) => Effect.Effect<Team, NotFound | AlreadyExists>;
    /** A team is deactivated and never deleted (RULE-233). */
    readonly deactivate: (id: TeamId) => Effect.Effect<Team, NotFound>;
  }
>()("@vektorprogrammet/domain/teams/TeamRepository") {}

export class PositionRepository extends Context.Service<
  PositionRepository,
  {
    readonly list: Effect.Effect<readonly Position[]>;
    readonly findById: (
      id: Position["id"]
    ) => Effect.Effect<Position, NotFound>;
  }
>()("@vektorprogrammet/domain/teams/PositionRepository") {}

export class MembershipRepository extends Context.Service<
  MembershipRepository,
  {
    readonly findById: (
      id: MembershipId
    ) => Effect.Effect<Membership, NotFound>;
    /** A membership of the locked person: a decision read, which runs after the lock. `NotFound` when it is not theirs. */
    readonly findLocked: (
      locked: Locked,
      id: MembershipId
    ) => Effect.Effect<Membership, NotFound>;
    /** Every membership of the locked person: a decision read, which runs after the lock. */
    readonly listLocked: (
      locked: Locked
    ) => Effect.Effect<readonly Membership[]>;
    /** Every membership of the team, the ended ones too (history shows both rows of a change), by start. */
    readonly listByTeam: (
      teamId: TeamId
    ) => Effect.Effect<readonly MembershipView[]>;
    /** Every membership of the person, newest first. */
    readonly listByPerson: (
      personId: PersonId
    ) => Effect.Effect<readonly MembershipView[]>;
    /** The memberships active in `semester`, across all departments. */
    readonly activeIn: (
      semester: Semester
    ) => Effect.Effect<readonly ActiveMembership[]>;
    /**
     * Inserts the locked person's membership (the owner is the lock's). A person's memberships in one team never
     * overlap: the database's exclusion constraint refuses an overlap, and that is `AlreadyExists`.
     */
    readonly insert: (
      locked: Locked,
      draft: Omit<MembershipDraft, "personId">
    ) => Effect.Effect<Membership, AlreadyExists>;
    /**
     * Moves the end of the locked person's membership that is Active in `activeIn` and whose end is still
     * `observedEnd`: `UPDATE … SET end = $new WHERE id = $1 AND person = $locked AND end = $observed AND active`. A
     * row in any other state, one that someone else changed since it was read, or one that is not theirs, is a
     * `Conflict`. A new end that overlaps another membership of the person in the team is `AlreadyExists`.
     */
    readonly setEnd: (
      locked: Locked,
      change: {
        readonly id: MembershipId;
        readonly observedEnd: Semester;
        readonly newEnd: Semester;
        readonly activeIn: Semester;
      }
    ) => Effect.Effect<Membership, Conflict | AlreadyExists>;
    /**
     * Removes the locked person's membership that is Planned in `current` and still has the term the caller read:
     * `DELETE … WHERE id = $1 AND person = $locked AND term = $observed AND start > current`. Anything else is a
     * `Conflict`.
     */
    readonly remove: (
      locked: Locked,
      removal: {
        readonly id: MembershipId;
        readonly observed: MembershipTerm;
        readonly current: Semester;
      }
    ) => Effect.Effect<void, Conflict>;
  }
>()("@vektorprogrammet/domain/teams/MembershipRepository") {}

export class AdminGrantRepository extends Context.Service<
  AdminGrantRepository,
  {
    /** Every place on the list, ended ones included, newest end first. */
    readonly list: Effect.Effect<readonly AdminGrantView[]>;
    readonly findById: (
      id: AdminGrantId
    ) => Effect.Effect<AdminGrant, NotFound>;
    /** Puts the locked person on the list (the holder is the lock's). */
    readonly create: (
      locked: Locked,
      draft: Omit<AdminGrantDraft, "personId">
    ) => Effect.Effect<AdminGrant>;
    /**
     * Removes a place, unless it is the last one that ends after `validAfter` (the end of the current semester). The
     * check and the delete are one atomic step: the people who hold a place that ends after `validAfter` are locked
     * first (`lockAll`, in id order), and the check reads the places of the locked people, which nobody else can
     * change before this transaction ends. Two revocations at once queue, and the second one is told it is the last.
     */
    readonly revoke: (
      id: AdminGrantId,
      validAfter: DateTime.Utc
    ) => Effect.Effect<"revoked" | "last", NotFound, InTransaction>;
  }
>()("@vektorprogrammet/domain/teams/AdminGrantRepository") {}

/** Records that the "ending soon" digest of a semester went to a leader, so that it goes out once (R1, falsifier 7). */
export class DigestLedger extends Context.Service<
  DigestLedger,
  {
    /** `true` when this call recorded the digest, `false` when an earlier one already had. */
    readonly claim: (
      personId: PersonId,
      semester: Semester
    ) => Effect.Effect<boolean>;
  }
>()("@vektorprogrammet/domain/teams/DigestLedger") {}

/** Loads the facts of a person's principal in one read (spec 0006: "loaded per request in one read"). */
export class PrincipalDirectory extends Context.Service<
  PrincipalDirectory,
  {
    /** One read of account state and principal facts; non-Active accounts are absent. */
    readonly activeById: (
      personId: PersonId,
      at: { readonly current: Semester; readonly now: DateTime.Utc }
    ) => Effect.Effect<Option.Option<PersonPrincipal>>;
    readonly byName: (
      name: string,
      at: { readonly current: Semester; readonly now: DateTime.Utc }
    ) => Effect.Effect<Option.Option<PersonPrincipal>>;
    /** The names of the people a local developer can act as, by id. */
    readonly names: (limit: number) => Effect.Effect<readonly string[]>;
  }
>()("@vektorprogrammet/domain/teams/PrincipalDirectory") {}
