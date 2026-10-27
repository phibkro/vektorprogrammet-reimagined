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
      locked: Locked<"Person">
    ) => Effect.Effect<Option.Option<Account>>;
    readonly list: Effect.Effect<readonly Account[]>;
    /** Whom to lock for a password reset; the caller rechecks through the lock. */
    readonly findActiveByPrivateEmail: (
      email: EmailAddress
    ) => Effect.Effect<Option.Option<Account>>;
    readonly invite: (
      locked: Locked<"Person">
    ) => Effect.Effect<Account, AlreadyExists>;
    /**
     * Applies one transition of the Account machine to the locked person's account:
     * `UPDATE … SET state = to WHERE person = $locked AND state = ANY(from)`. An account that is not in a state the
     * transition starts from (any more) is a `Conflict`.
     */
    readonly transition: (
      locked: Locked<"Person">,
      transition: AccountMachineTransition
    ) => Effect.Effect<Account, Conflict>;
    /**
     * Whether `personId` is the only Active administrator: the only person who holds a place that is valid at `now`
     * and whose account is Active. The decision spans every administrator, so it is read through the admin list's
     * token: every command that can change who is an Active administrator holds that lock first, and nobody else can
     * change what this reads before this transaction ends.
     */
    readonly isLastActiveAdmin: (
      adminList: Locked<"AdminList">,
      personId: PersonId,
      now: DateTime.Utc
    ) => Effect.Effect<boolean>;
    readonly verifyEmail: (
      locked: Locked<"Person">
    ) => Effect.Effect<void, AlreadyExists>;
    readonly updateProfile: (
      locked: Locked<"Person">,
      profile: PersonDraft
    ) => Effect.Effect<Person, AlreadyExists>;
  }
>()("@vektorprogrammet/domain/accounts/AccountRepository") {}
