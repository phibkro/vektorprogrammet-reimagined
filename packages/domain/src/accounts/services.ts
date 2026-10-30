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
import type { InTransaction } from "../shared/transaction.ts";
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
    ) => Effect.Effect<Option.Option<Account>, never, InTransaction>;
    readonly list: Effect.Effect<readonly Account[]>;
    /** Whom to lock for a password reset; the caller rechecks through the lock. */
    readonly findActiveByPrivateEmail: (
      email: EmailAddress
    ) => Effect.Effect<Option.Option<Account>>;
    readonly invite: (
      locked: Locked<"Person">
    ) => Effect.Effect<Account, AlreadyExists, InTransaction>;
    /**
     * Applies one transition of the Account machine to the locked person's account, only while the account is in a
     * state that the transition starts from, judged on its newest committed state (CW1). An account that is not in
     * such a state (any more) is a `Conflict`.
     */
    readonly transition: (
      locked: Locked<"Person">,
      transition: AccountMachineTransition
    ) => Effect.Effect<Account, Conflict, InTransaction>;
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
    ) => Effect.Effect<boolean, never, InTransaction>;
    readonly verifyEmail: (
      locked: Locked<"Person">
    ) => Effect.Effect<void, AlreadyExists, InTransaction>;
    /** The locked person's address and whether it is verified: a decision read, which runs after the lock. */
    readonly emailOf: (
      locked: Locked<"Person">
    ) => Effect.Effect<
      { readonly email: EmailAddress; readonly verified: boolean },
      never,
      InTransaction
    >;
    /**
     * Whom to lock when an address is verified: the person who holds `email` verified, if one does (the unique index
     * allows one). The caller rechecks through the locks.
     */
    readonly verifiedHolderOf: (
      email: EmailAddress
    ) => Effect.Effect<Option.Option<PersonId>>;
    readonly updateProfile: (
      locked: Locked<"Person">,
      profile: PersonDraft
    ) => Effect.Effect<Person, AlreadyExists | Conflict, InTransaction>;
  }
>()("@vektorprogrammet/domain/accounts/AccountRepository") {}
