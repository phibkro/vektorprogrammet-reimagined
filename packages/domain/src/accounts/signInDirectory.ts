/**
 * What the authentication adapter may ask of the domain (spec 0017, ADR 0014: Better Auth keeps its own adapter and its
 * own tables, and its reads of domain tables go through ports).
 *
 * Better Auth owns the sign-in identities (`auth_user`: an address and a password); the domain owns the people and their
 * accounts. The one link is a person's id on the identity (`auth_user.person_id`), and this port is where that link is
 * read. Every method is a read that writes nothing and takes no lock, and answers from one statement. A failure of the
 * store is a defect, like every repository's, and a stored row that does not decode is a defect and never absence.
 *
 * Whether the person's account is Active is not asked here: it is `AccountRepository.find`, the domain's own read.
 */
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import { PersonId } from "../shared/ids.ts";

/**
 * Which sign-in identity answers to an address a person typed: the one identity whose person has that private or
 * company address (`Unique`, with the identity's own address), none (`Unknown`), or more than one (`Ambiguous`). The
 * last two are refused the same way, and the same way as a wrong password.
 */
export const SignInMatch = Schema.TaggedUnion({
  Ambiguous: {},
  Unique: { email: Schema.String },
  Unknown: {},
});

export type SignInMatch = typeof SignInMatch.Type;

/** The profile that a sign-in identity is created from. */
export const SignInProfile = Schema.Struct({
  email: Schema.String,
  emailVerified: Schema.Boolean,
  id: PersonId,
  name: Schema.String,
});

export type SignInProfile = typeof SignInProfile.Type;

export class SignInDirectory extends Context.Service<
  SignInDirectory,
  {
    /** The person that owns the Better Auth user `userId`; `None` for a user with no person. */
    readonly personOfUser: (
      userId: string
    ) => Effect.Effect<Option.Option<PersonId>>;
    /** Which identity answers to `address`, already lower-cased by the caller: a person's private or company address. */
    readonly match: (address: string) => Effect.Effect<SignInMatch>;
    /** The sign-in address of a person's identity; `None` before the person's first activation. */
    readonly signInEmailOf: (
      personId: PersonId
    ) => Effect.Effect<Option.Option<string>>;
    /** The profile that an identity is created from; `None` for a person that does not exist. */
    readonly profileOf: (
      personId: PersonId
    ) => Effect.Effect<Option.Option<SignInProfile>>;
  }
>()("@vektorprogrammet/domain/accounts/SignInDirectory") {}
