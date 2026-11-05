import { eq, or, sql } from "drizzle-orm";
import { Effect, Layer, Option, Schema } from "effect";

/** Authentication identity lookups use Supabase administrator-owned app metadata. */
import { PersonId } from "../../../domain/ids.ts";
import {
  SignInDirectory,
  SignInMatch,
  SignInProfile,
} from "../../../features/accounts/domain/signInDirectory.ts";
import { Drizzle, decodeFirstOption, decodeWith } from "../internal/drizzle.ts";
import { person } from "../schema.ts";

const OwnerRow = Schema.Struct({ personId: PersonId });
const EmailRow = Schema.Struct({ email: Schema.String });

/**
 * A failed lookup as a defect that names the operation and nothing the failed statement carried. Drizzle's query error
 * holds the SQL and, when the driver is configured to report them, its parameters (here the address a visitor typed),
 * and a defect is logged and rendered. The failure is typed here, so `Effect.catch` sees it and an interruption passes.
 */
const lookupFailed = (operation: string) => () =>
  Effect.die(`SignInDirectory.${operation} failed`);

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
          .select({
            personId: sql<number>`vektor_private.users.person_id::integer`,
          })
          .from(sql`vektor_private.users`)
          .where(sql`vektor_private.users.id::text = ${userId}`)
          .pipe(Effect.catch(lookupFailed("personOfUser")));

        return Option.map(yield* decodeOwner(rows), (row) => row.personId);
      }
    );

    const match = Effect.fn("SignInDirectory.match")(function* match(
      address: string
    ) {
      // Two rows are enough to know that the address is ambiguous.
      const rows = yield* db
        .select({ email: sql<string>`vektor_private.users.email` })
        .from(person)
        .innerJoin(
          sql`vektor_private.users`,
          sql`vektor_private.users.person_id = ${person.id}::text`
        )
        .where(or(eq(person.email, address), eq(person.companyEmail, address)))
        .limit(2)
        .pipe(Effect.catch(lookupFailed("match")));

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
          .select({ email: sql<string>`vektor_private.users.email` })
          .from(sql`vektor_private.users`)
          .where(sql`vektor_private.users.person_id = ${personId}::text`)
          .limit(1)
          .pipe(Effect.catch(lookupFailed("signInEmailOf")));

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
          .pipe(Effect.catch(lookupFailed("profileOf")));

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
