/**
 * Account persistence. An account belongs to a person (spec 0006b): every write takes the person's `Locked` token, and
 * so does every read that a decision rests on. A state change is a transition of the Account machine, applied with
 * `UPDATE … WHERE state = ANY(from)`.
 */
import {
  AccountRepository,
  AccountState,
  AlreadyExists,
  Person,
  PersonId,
} from "@vektorprogrammet/domain";
import type {
  Account,
  EmailAddress,
  Locked,
  PersonDraft,
} from "@vektorprogrammet/domain";
import { and, eq, gt, inArray } from "drizzle-orm";
import { Array as Arr, DateTime, Effect, Layer, Option, Schema } from "effect";

import { Aggregates } from "../aggregate/aggregates.ts";
import { roots as aggregateRoots } from "../aggregate/declaration.ts";
import { classifySqlFailure } from "../classifySqlFailure.ts";
import { Drizzle, decodeFirstOption, decodeWith } from "../internal/drizzle.ts";
import { account, adminGrant, fieldOfStudy, person } from "../schema.ts";

const StoredAccount = Schema.Struct({
  personId: PersonId,
  state: Schema.Literals(["Active", "Deactivated", "Invited"]),
});

const decodeAccount = decodeWith(StoredAccount);
const decodePerson = decodeWith(Person);
const decodePersonIds = decodeWith(Schema.Array(PersonId));

/** The tables that a person owns: every write to one goes through the person's lock. */
const { owned } = aggregateRoots.Person;

const states = {
  Active: AccountState.cases.Active.make({}),
  Deactivated: AccountState.cases.Deactivated.make({}),
  Invited: AccountState.cases.Invited.make({}),
} as const;

const accountOf = (row: typeof StoredAccount.Type): Account => ({
  personId: row.personId,
  state: states[row.state],
});

const CHANGED = "Kontoen ble endret eller kan ikke deaktiveres.";

export const AccountRepositoryLive = Layer.effect(
  AccountRepository,
  Effect.gen(function* AccountRepositoryLive() {
    const db = yield* Drizzle;
    const aggregates = yield* Aggregates;

    const list = db
      .select()
      .from(account)
      .pipe(
        Effect.orDie,
        Effect.flatMap(decodeWith(Schema.Array(StoredAccount))),
        Effect.map((rows) => Arr.map(rows, accountOf))
      );

    const find = Effect.fn("AccountRepository.find")(function* find(
      personId: PersonId
    ) {
      const rows = yield* db
        .select()
        .from(account)
        .where(eq(account.personId, personId))
        .pipe(Effect.orDie);

      return Option.map(
        yield* decodeFirstOption(decodeAccount)(rows),
        accountOf
      );
    });

    const findLocked = Effect.fn("AccountRepository.findLocked")(
      function* findLocked(locked: Locked) {
        const rows = yield* aggregates
          .select(locked, owned.account)
          .pipe(Effect.orDie);

        return Option.map(
          yield* decodeFirstOption(decodeAccount)(rows),
          accountOf
        );
      }
    );

    const findActiveByPrivateEmail = Effect.fn(
      "AccountRepository.findActiveByPrivateEmail"
    )(function* findActiveByPrivateEmail(email: EmailAddress) {
      const rows = yield* db
        .select({ personId: account.personId, state: account.state })
        .from(account)
        .innerJoin(person, eq(person.id, account.personId))
        .where(and(eq(person.email, email), eq(account.state, "Active")))
        .pipe(Effect.orDie);

      return Option.map(
        yield* decodeFirstOption(decodeAccount)(rows),
        accountOf
      );
    });

    const adminHolders = Effect.fn("AccountRepository.adminHolders")(
      function* adminHolders(now: DateTime.Utc) {
        const rows = yield* db
          .selectDistinct({ personId: adminGrant.personId })
          .from(adminGrant)
          .where(gt(adminGrant.until, DateTime.toDateUtc(now)))
          .pipe(Effect.orDie);

        return yield* decodePersonIds(Arr.map(rows, (row) => row.personId));
      }
    );

    const invite = Effect.fn("AccountRepository.invite")(function* invite(
      locked: Locked
    ) {
      const rows = yield* aggregates
        .insert(
          locked,
          owned.account,
          { state: "Invited" },
          { action: "ignore" }
        )
        .pipe(Effect.orDie);

      if (rows.length === 0) {
        return yield* new AlreadyExists({
          entity: "Account",
          key: String(locked.id),
          message: "Personen har allerede en konto.",
        });
      }

      return accountOf(yield* decodeAccount(rows[0]));
    });

    const transition = Effect.fn("AccountRepository.transition")(
      function* transition(
        locked: Locked,
        change: Parameters<AccountRepository["Service"]["transition"]>[1]
      ) {
        const row = yield* aggregates
          .apply(change, locked, {
            entity: "Account",
            key: String(locked.id),
            message: CHANGED,
            owned: owned.account,
          })
          .pipe(
            Effect.catchTag("EffectDrizzleQueryError", (error) =>
              Effect.die(error)
            )
          );

        return accountOf(yield* decodeAccount(row));
      }
    );

    /**
     * The people among `locks` who hold an admin place that is valid at `now`, and have an Active account: both are
     * read through the tokens, so nobody else can change them before this transaction ends. The caller locked the
     * person and every holder in one `lockAll`, so the person is the last one exactly when no other active
     * administrator is among the locked.
     */
    const isLastActiveAdmin = Effect.fn("AccountRepository.isLastActiveAdmin")(
      function* isLastActiveAdmin(
        locks: readonly Locked[],
        personId: PersonId,
        now: DateTime.Utc
      ) {
        const grants = yield* aggregates.select(
          locks,
          owned.adminGrant,
          gt(adminGrant.until, DateTime.toDateUtc(now))
        );

        const holders = Arr.dedupe(Arr.map(grants, (grant) => grant.personId));

        const active = yield* aggregates.select(
          locks,
          owned.account,
          and(inArray(account.personId, holders), eq(account.state, "Active"))
        );

        return active.length === 1 && active[0]?.personId === personId;
      },
      Effect.orDie
    );

    const verifyEmail = Effect.fn("AccountRepository.verifyEmail")(
      function* verifyEmail(locked: Locked) {
        yield* aggregates
          .updateRoot(locked, aggregateRoots.Person, { emailVerified: true })
          .pipe(
            Effect.catch((error) =>
              classifySqlFailure(error, String(locked.id))
            )
          );
      }
    );

    const updateProfile = Effect.fn("AccountRepository.updateProfile")(
      function* updateProfile(locked: Locked, profile: PersonDraft) {
        yield* aggregates.assertHeld(aggregateRoots.Person, locked);

        const [current] = yield* db
          .select({ email: person.email })
          .from(person)
          .where(eq(person.id, locked.id))
          .pipe(Effect.orDie);

        // A changed address is not verified until the person verifies it again.
        const set =
          current?.email === profile.email
            ? profile
            : { ...profile, emailVerified: false };

        yield* aggregates
          .updateRoot(locked, aggregateRoots.Person, set)
          .pipe(
            Effect.catch((error) => classifySqlFailure(error, profile.email))
          );

        const rows = yield* db
          .select({
            companyEmail: person.companyEmail,
            departmentId: fieldOfStudy.departmentId,
            email: person.email,
            fieldOfStudyId: person.fieldOfStudyId,
            id: person.id,
            name: person.name,
          })
          .from(person)
          .innerJoin(fieldOfStudy, eq(person.fieldOfStudyId, fieldOfStudy.id))
          .where(eq(person.id, locked.id))
          .pipe(Effect.orDie);

        return yield* decodePerson(rows[0]);
      }
    );

    return AccountRepository.of({
      adminHolders,
      find,
      findActiveByPrivateEmail,
      findLocked,
      invite,
      isLastActiveAdmin,
      list,
      transition,
      updateProfile,
      verifyEmail,
    });
  })
);
