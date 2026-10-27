/** Account persistence. Every state transition is conditional. */
import {
  AccountRepository,
  AccountState,
  AlreadyExists,
  Conflict,
  NotFound,
  Person,
  PersonId,
} from "@vektorprogrammet/domain";
import type {
  Account,
  EmailAddress,
  PersonDraft,
} from "@vektorprogrammet/domain";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { Array as Arr, DateTime, Effect, Layer, Option, Schema } from "effect";

import { classifySqlFailure } from "../classifySqlFailure.ts";
import { Drizzle, decodeFirstOption, decodeWith } from "../internal/drizzle.ts";
import { account, adminGrant, fieldOfStudy, person } from "../schema.ts";

const StoredAccount = Schema.Struct({
  personId: PersonId,
  state: Schema.Literals(["Active", "Deactivated", "Invited"]),
});

const decodeAccount = decodeWith(StoredAccount);
const decodePerson = decodeWith(Person);

const states = {
  Active: AccountState.cases.Active.make({}),
  Deactivated: AccountState.cases.Deactivated.make({}),
  Invited: AccountState.cases.Invited.make({}),
} as const;

const accountOf = (row: typeof StoredAccount.Type): Account => ({
  personId: row.personId,
  state: states[row.state],
});

const changed = (personId: PersonId) =>
  new Conflict({
    entity: "Account",
    key: String(personId),
    message: "Kontoen ble endret eller kan ikke deaktiveres.",
  });

export const AccountRepositoryLive = Layer.effect(
  AccountRepository,
  Effect.gen(function* AccountRepositoryLive() {
    const db = yield* Drizzle;

    /** The caller holds a transaction; every guarded write takes the Person aggregate lock first. */
    const lockPerson = Effect.fn("AccountRepository.lockPerson")(
      function* lockPerson(personId: PersonId) {
        const rows = yield* db
          .select({ id: person.id })
          .from(person)
          .where(eq(person.id, personId))
          .for("no key update")
          .pipe(Effect.orDie);

        return rows.length === 1;
      }
    );

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

    const findForUpdate = Effect.fn("AccountRepository.findForUpdate")(
      function* findForUpdate(personId: PersonId) {
        const rows = yield* db
          .select()
          .from(account)
          .where(eq(account.personId, personId))
          .for("update")
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

    const invite = Effect.fn("AccountRepository.invite")(function* invite(
      personId: PersonId
    ) {
      const rows = yield* db
        .insert(account)
        .values({ personId, state: "Invited" })
        .onConflictDoNothing()
        .returning()
        .pipe(Effect.orDie);

      if (rows.length === 0) {
        return yield* new AlreadyExists({
          entity: "Account",
          key: String(personId),
          message: "Personen har allerede en konto.",
        });
      }

      return accountOf(yield* decodeAccount(rows[0]));
    });

    /** Lock all current admin grants in id order before testing the invariant. */
    const activeAdminIds = Effect.fnUntraced(function* activeAdminIds(
      now: DateTime.Utc,
      lock: boolean
    ) {
      const query = db
        .select({ personId: adminGrant.personId })
        .from(adminGrant)
        .where(gt(adminGrant.until, DateTime.toDateUtc(now)))
        .orderBy(asc(adminGrant.id));

      const grants = yield* lock ? query.for("update") : query;

      const ids = [...new Set(Arr.map(grants, (grant) => grant.personId))];

      if (ids.length === 0) {
        return [];
      }

      return yield* db
        .select({ personId: account.personId })
        .from(account)
        .where(
          and(inArray(account.personId, ids), eq(account.state, "Active"))
        );
    }, Effect.orDie);

    const isLastActiveAdmin = Effect.fn("AccountRepository.isLastActiveAdmin")(
      function* isLastActiveAdmin(personId: PersonId, now: DateTime.Utc) {
        const active = yield* activeAdminIds(now, false);

        return active.length === 1 && active[0]?.personId === personId;
      }
    );

    const transition = Effect.fn("AccountRepository.transition")(
      function* transition(
        change: Parameters<AccountRepository["Service"]["transition"]>[0]
      ) {
        if (change.prohibitLastActiveAdmin) {
          const active = yield* activeAdminIds(change.now, true);

          if (active.length === 1 && active[0]?.personId === change.personId) {
            return yield* changed(change.personId);
          }
        }

        const rows = yield* db
          .update(account)
          .set({ state: change.to })
          .where(
            and(
              eq(account.personId, change.personId),
              eq(account.state, change.from)
            )
          )
          .returning()
          .pipe(Effect.orDie);

        if (rows.length === 0) {
          return yield* changed(change.personId);
        }

        return accountOf(yield* decodeAccount(rows[0]));
      }
    );

    const verifyEmail = Effect.fn("AccountRepository.verifyEmail")(
      function* verifyEmail(personId: PersonId) {
        yield* db
          .update(person)
          .set({ emailVerified: true })
          .where(eq(person.id, personId))
          .pipe(
            Effect.catch((error) => classifySqlFailure(error, String(personId)))
          );
      }
    );

    const updateProfile = Effect.fn("AccountRepository.updateProfile")(
      function* updateProfile(personId: PersonId, profile: PersonDraft) {
        const current = yield* db
          .select({ email: person.email })
          .from(person)
          .where(eq(person.id, personId))
          .pipe(Effect.orDie);

        if (current.length === 0) {
          return yield* new NotFound({
            entity: "Person",
            key: String(personId),
          });
        }

        yield* db
          .update(person)
          .set({
            ...profile,
            emailVerified:
              current[0]?.email === profile.email ? undefined : false,
          })
          .where(eq(person.id, personId))
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
          .where(eq(person.id, personId))
          .pipe(Effect.orDie);

        return yield* decodePerson(rows[0]);
      }
    );

    return AccountRepository.of({
      find,
      findActiveByPrivateEmail,
      findForUpdate,
      invite,
      isLastActiveAdmin,
      list,
      lockPerson,
      transition,
      updateProfile,
      verifyEmail,
    });
  })
);
