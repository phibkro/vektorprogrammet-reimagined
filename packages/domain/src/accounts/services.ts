/**
 * Persistence and credential capabilities used by the Account commands.
 *
 * An account belongs to one person (spec 0006b): every write takes the person's `Locked` token, and so does every read
 * that a decision rests on. A command locks first (`AggregateLocks`), reads through the token, decides, and writes
 * through the token. The reads without a token are for display and for finding whom to lock.
 */
import { Context } from "effect";
import type { DateTime, Effect, Option } from "effect";

import type { Locked } from "../shared/aggregate.ts";
import type { AlreadyExists, Conflict } from "../shared/errors.ts";
import type { PersonId } from "../shared/ids.ts";
import type { EmailAddress } from "../shared/validation.ts";
import type { Person, PersonDraft } from "../teams/entities.ts";
import type { AccountMachineTransition } from "./declaration.ts";
import type { Account } from "./entities.ts";

export class AccountRepository extends Context.Service<
  AccountRepository,
  {
    readonly find: (
      personId: PersonId
    ) => Effect.Effect<Option.Option<Account>>;
    /** The locked person's account: a decision read, which runs after the lock and which nobody else can change. */
    readonly findLocked: (
      locked: Locked
    ) => Effect.Effect<Option.Option<Account>>;
    readonly list: Effect.Effect<readonly Account[]>;
    /** Whom to lock for a password reset; the caller rechecks through the lock. */
    readonly findActiveByPrivateEmail: (
      email: EmailAddress
    ) => Effect.Effect<Option.Option<Account>>;
    /** The people who hold an admin place that is valid at `now`: whom to lock for the last-active-admin rule. */
    readonly adminHolders: (
      now: DateTime.Utc
    ) => Effect.Effect<readonly PersonId[]>;
    readonly invite: (locked: Locked) => Effect.Effect<Account, AlreadyExists>;
    /**
     * Applies one transition of the Account machine to the locked person's account:
     * `UPDATE … SET state = to WHERE person = $locked AND state = ANY(from)`. An account that is not in a state the
     * transition starts from (any more) is a `Conflict`.
     */
    readonly transition: (
      locked: Locked,
      transition: AccountMachineTransition
    ) => Effect.Effect<Account, Conflict>;
    /**
     * Whether `personId` is the only person with a valid admin place and an Active account among the locked people.
     * The caller locked the person and every holder in one `lockAll`, so nobody else can change what this reads.
     */
    readonly isLastActiveAdmin: (
      locks: readonly Locked[],
      personId: PersonId,
      now: DateTime.Utc
    ) => Effect.Effect<boolean>;
    readonly verifyEmail: (
      locked: Locked
    ) => Effect.Effect<void, AlreadyExists>;
    readonly updateProfile: (
      locked: Locked,
      profile: PersonDraft
    ) => Effect.Effect<Person, AlreadyExists>;
  }
>()("@vektorprogrammet/domain/accounts/AccountRepository") {}
