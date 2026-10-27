/** Persistence and credential capabilities used by the Account commands. */
import { Context } from "effect";
import type { DateTime, Effect, Option } from "effect";

import type { AlreadyExists, Conflict, NotFound } from "../shared/errors.ts";
import type { PersonId } from "../shared/ids.ts";
import type { EmailAddress } from "../shared/validation.ts";
import type { Person, PersonDraft } from "../teams/entities.ts";
import type { Account, AccountState } from "./entities.ts";

export class AccountRepository extends Context.Service<
  AccountRepository,
  {
    /** Lock the Person row with FOR NO KEY UPDATE in the caller's transaction. */
    readonly lockPerson: (personId: PersonId) => Effect.Effect<boolean>;
    readonly find: (
      personId: PersonId
    ) => Effect.Effect<Option.Option<Account>>;
    readonly list: Effect.Effect<readonly Account[]>;
    /** Lock the account row for a command so state cannot change before code consumption. */
    readonly findForUpdate: (
      personId: PersonId
    ) => Effect.Effect<Option.Option<Account>>;
    readonly findActiveByPrivateEmail: (
      email: EmailAddress
    ) => Effect.Effect<Option.Option<Account>>;
    readonly invite: (
      personId: PersonId
    ) => Effect.Effect<Account, AlreadyExists>;
    /** The predicate and state change are serialized with concurrent admin changes. */
    readonly transition: (change: {
      readonly personId: PersonId;
      readonly from: AccountState["_tag"];
      readonly to: AccountState["_tag"];
      readonly prohibitLastActiveAdmin: boolean;
      readonly now: DateTime.Utc;
    }) => Effect.Effect<Account, Conflict>;
    readonly isLastActiveAdmin: (
      personId: PersonId,
      now: DateTime.Utc
    ) => Effect.Effect<boolean>;
    readonly verifyEmail: (
      personId: PersonId
    ) => Effect.Effect<void, AlreadyExists>;
    readonly updateProfile: (
      personId: PersonId,
      profile: PersonDraft
    ) => Effect.Effect<Person, NotFound | AlreadyExists>;
  }
>()("@vektorprogrammet/domain/accounts/AccountRepository") {}
