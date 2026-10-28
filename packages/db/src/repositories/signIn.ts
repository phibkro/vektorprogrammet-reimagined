/**
 * The adapter of `SignInDirectory` (declared by the domain): the reads that Better Auth made of domain tables with its own
 * pool, as plain selects of the application's connection. The one link between a sign-in identity and a person is
 * `auth_user.person_id`.
 */
import {
  PersonId,
  SignInDirectory,
  SignInMatch,
  SignInProfile,
} from "@vektorprogrammet/domain";
import { eq, or } from "drizzle-orm";
import { Effect, Layer, Option, Schema } from "effect";

import { Drizzle, decodeFirstOption, decodeWith } from "../internal/drizzle.ts";
import { authUser, person } from "../schema.ts";

const OwnerRow = Schema.Struct({ personId: PersonId });
const EmailRow = Schema.Struct({ email: Schema.String });

export const SignInDirectoryLive = Layer.effect(
  SignInDirectory,
  Effect.gen(function* SignInDirectoryLive() {
    const db = yield* Drizzle;
    const decodeOwner = decodeFirstOption(decodeWith(OwnerRow));
    const decodeEmails = decodeWith(Schema.Array(EmailRow));
    const decodeEmail = decodeFirstOption(decodeWith(EmailRow));
    const decodeProfile = decodeFirstOption(decodeWith(SignInProfile));

    const personOfUser = Effect.fn("SignInDirectory.personOfUser")(
      function* personOfUser(userId: string) {
        const rows = yield* db
          .select({ personId: authUser.personId })
          .from(authUser)
          .where(eq(authUser.id, userId))
          .pipe(Effect.orDie);

        return Option.map(yield* decodeOwner(rows), (row) => row.personId);
      }
    );

    const match = Effect.fn("SignInDirectory.match")(function* match(
      address: string
    ) {
      // Two rows are enough to know that the address is ambiguous.
      const rows = yield* db
        .select({ email: authUser.email })
        .from(person)
        .innerJoin(authUser, eq(authUser.personId, person.id))
        .where(or(eq(person.email, address), eq(person.companyEmail, address)))
        .limit(2)
        .pipe(Effect.orDie);

      const [first, second] = yield* decodeEmails(rows);

      if (first === undefined) {
        return SignInMatch.cases.Unknown.make({});
      }

      return second === undefined
        ? SignInMatch.cases.Unique.make({ email: first.email })
        : SignInMatch.cases.Ambiguous.make({});
    });

    const signInEmailOf = Effect.fn("SignInDirectory.signInEmailOf")(
      function* signInEmailOf(personId: PersonId) {
        const rows = yield* db
          .select({ email: authUser.email })
          .from(authUser)
          .where(eq(authUser.personId, personId))
          .limit(1)
          .pipe(Effect.orDie);

        return Option.map(yield* decodeEmail(rows), (row) => row.email);
      }
    );

    const profileOf = Effect.fn("SignInDirectory.profileOf")(
      function* profileOf(personId: PersonId) {
        const rows = yield* db
          .select({
            email: person.email,
            emailVerified: person.emailVerified,
            id: person.id,
            name: person.name,
          })
          .from(person)
          .where(eq(person.id, personId))
          .pipe(Effect.orDie);

        return yield* decodeProfile(rows);
      }
    );

    return SignInDirectory.of({
      match,
      personOfUser,
      profileOf,
      signInEmailOf,
    });
  })
);
