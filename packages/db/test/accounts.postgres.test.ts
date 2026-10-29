/** Spec 0007 falsifiers 2 and 4: real PostgreSQL code concurrency, expiry, scope and account states. */
import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import {
  AccountEndpoints,
  AccountRepository,
  CodeRepository,
  CurrentPrincipal,
  EmailAddress,
  PasswordHasher,
  PersonId,
  PersonRepository,
  Principal,
  authorize,
  codePrincipal,
  mintCode,
} from "@vektorprogrammet/domain";
import type {
  Code,
  CodePurpose,
  Locked,
  SingleUsePurpose,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { transactional } from "../src/index.ts";
import { activeAdmin, moveAccount } from "./support/accountsWorld.ts";
import { issueUnsent, issueUsable } from "./support/codes.ts";
import { postgresDatabase } from "./support/database.ts";
import { raceReport } from "./support/race.ts";
import { asPerson, lockPerson, world } from "./support/teamsWorld.ts";

const expiresAt = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");
const beforeExpiry = DateTime.makeUnsafe("2098-12-31T23:59:59.999Z");
const now = DateTime.makeUnsafe("2026-10-27T12:00:00.000Z");

const RACE_ROUNDS = 300;

const lapsed = DateTime.makeUnsafe("2020-01-01T00:00:00.000Z");

type Built = "expired" | "unsent" | "usable" | "used";

/**
 * What the delivery's two transactions, and a use, leave in the store: the code `Unsent`; acknowledged; acknowledged and
 * spent (`expired` is acknowledged, with an expiry in the past).
 */
const storeAs = Effect.fnUntraced(function* storeAs(
  locked: Locked<"Person">,
  built: Built,
  code: Pick<Code, "expiresAt" | "hash"> & {
    readonly purpose: SingleUsePurpose;
  }
) {
  if (built === "unsent") {
    return yield* issueUnsent(locked, code);
  }

  yield* issueUsable(locked, code);

  if (built === "used") {
    yield* CodeRepository.use((codes) =>
      codes.consume(locked, {
        hash: code.hash,
        now,
        purpose: code.purpose,
      })
    );
  }

  return yield* Effect.void;
});

type AccountStateName = "Invited" | "Active" | "Deactivated";

const assertAuthority = (
  principal: Principal,
  purpose: CodePurpose,
  personId: PersonId
) => {
  const command =
    purpose === "activation" ? "activateAccount" : "resetPassword";

  const other = purpose === "activation" ? "resetPassword" : "activateAccount";
  assert.isTrue(authorize(principal, command, { personId }));
  assert.isFalse(authorize(principal, other, { personId }));
  assert.isFalse(
    authorize(principal, command, { personId: PersonId.make(personId + 1) })
  );
  assert.isFalse(authorize(principal, "deactivateAccount", { personId }));
};

const checkPurpose = Effect.fnUntraced(function* checkPurpose(
  personId: PersonId,
  state: AccountStateName,
  purpose: CodePurpose
) {
  const code = yield* mintCode().pipe(Effect.orDie);

  yield* asPerson(personId, (locked) =>
    issueUsable(locked, { expiresAt, hash: code.hash, purpose })
  );

  const principal = yield* codePrincipal(code.token, purpose);

  const expected =
    (purpose === "activation" && state === "Invited") ||
    (purpose === "resetPassword" && state === "Active");

  assert.strictEqual(Option.isSome(principal), expected);

  if (Option.isSome(principal)) {
    assertAuthority(principal.value, purpose, personId);
  }
});

layer(
  Layer.merge(
    postgresDatabase().pipe(Layer.provideMerge(NodeServices.layer)),
    Layer.mock(PasswordHasher, {})
  ),
  {
    excludeTestServices: true,
  }
)("RULE-131, 132, 201, 220: single-use credentials on PostgreSQL", (it) => {
  it.effect(
    "100 rounds: a Person aggregate lock holds until transaction completion",
    () =>
      Effect.gen(function* personLockProperty() {
        const fixture = yield* world("person-lock");
        const people = yield* PersonRepository;
        const sql = yield* SqlClient;

        for (const round of Arr.range(1, 100)) {
          const person = yield* transactional(
            people.create({
              email: EmailAddress.make(`lock-${round}@example.org`),
              fieldOfStudyId: fixture.fieldOfStudy.id,
              name: `Person lock ${round}`,
            })
          );

          const locked = yield* Deferred.make<null>();
          const release = yield* Deferred.make<null>();

          const holder = yield* Effect.forkChild(
            transactional(
              Effect.gen(function* holdPersonLock() {
                const found = yield* lockPerson(person.id);
                yield* Deferred.succeed(locked, null);
                yield* Deferred.await(release);

                return found.id === person.id;
              })
            )
          );

          yield* Deferred.await(locked);

          const competitor = yield* Effect.exit(
            transactional(
              sql`select id from person where id = ${person.id} for no key update nowait`
            )
          );

          yield* Deferred.succeed(release, null);
          const held = yield* Fiber.await(holder);

          const report = raceReport<unknown, unknown>(round, [
            competitor,
            held,
          ]);

          assert.isTrue(Exit.isSuccess(held) && held.value, report);
          assert.isTrue(Exit.isFailure(competitor), report);

          if (Exit.isFailure(competitor)) {
            assert.include(
              Cause.pretty(competitor.cause),
              "could not obtain lock on row",
              report
            );
          }

          // With the holder gone the identical competing statement must succeed.
          const released =
            yield* sql`select id from person where id = ${person.id} for no key update nowait`;

          assert.strictEqual(released.length, 1, report);
        }
      }),
    120_000
  );

  it.effect(
    "300 rounds: 20 concurrent uses of each fresh code have exactly one winner",
    () =>
      Effect.gen(function* codeConcurrency() {
        const fixture = yield* world("code-race");
        const codes = yield* CodeRepository;

        for (const round of Arr.range(1, RACE_ROUNDS)) {
          const { hash } = yield* mintCode().pipe(Effect.orDie);

          yield* asPerson(fixture.person.id, (locked) =>
            issueUsable(locked, { expiresAt, hash, purpose: "activation" })
          );

          const uses = yield* Effect.all(
            Arr.makeBy(20, () =>
              Effect.exit(
                asPerson(fixture.person.id, (locked) =>
                  codes.consume(locked, {
                    hash,
                    now,
                    purpose: "activation",
                  })
                )
              )
            ),
            { concurrency: "unbounded" }
          );

          const report = raceReport(round, uses);
          assert.strictEqual(
            Arr.filter(uses, Exit.isFailure).length,
            0,
            report
          );
          assert.strictEqual(
            Arr.filter(uses, (exit) => Exit.isSuccess(exit) && exit.value)
              .length,
            1,
            report
          );
        }
      }),
    120_000
  );

  it.effect(
    "expiry is strict to the millisecond, scope is exact, and resend invalidates the older code",
    () =>
      Effect.gen(function* codeBoundaries() {
        const fixture = yield* world("code-boundary");
        const other = yield* world("code-other");
        const codes = yield* CodeRepository;
        const first = yield* mintCode().pipe(Effect.orDie);
        const second = yield* mintCode().pipe(Effect.orDie);

        const replace = (hash: typeof first.hash) =>
          asPerson(fixture.person.id, (locked) =>
            issueUsable(locked, { expiresAt, hash, purpose: "activation" })
          );

        /** One presentation of a code by `personId`: the lock that a command takes is the subject. */
        const consume = (
          personId: PersonId,
          presented: {
            readonly hash: typeof first.hash;
            readonly now: DateTime.Utc;
            readonly purpose: SingleUsePurpose;
          }
        ) => asPerson(personId, (locked) => codes.consume(locked, presented));

        yield* replace(first.hash);

        assert.isFalse(
          yield* consume(fixture.person.id, {
            hash: first.hash,
            now: beforeExpiry,
            purpose: "resetPassword",
          })
        );
        assert.isFalse(
          yield* consume(other.person.id, {
            hash: first.hash,
            now: beforeExpiry,
            purpose: "activation",
          })
        );
        assert.isFalse(
          yield* consume(fixture.person.id, {
            hash: first.hash,
            now: expiresAt,
            purpose: "activation",
          })
        );
        assert.isTrue(
          yield* consume(fixture.person.id, {
            hash: first.hash,
            now: beforeExpiry,
            purpose: "activation",
          })
        );
        yield* replace(first.hash);
        yield* replace(second.hash);
        assert.isFalse(
          yield* consume(fixture.person.id, {
            hash: first.hash,
            now,
            purpose: "activation",
          })
        );
        assert.isTrue(
          yield* consume(fixture.person.id, {
            hash: second.hash,
            now,
            purpose: "activation",
          })
        );
      })
  );

  it.effect(
    "spec 0024 F5: the reusable alumni code answers only while it is Usable and unexpired, for a person with no account; an unsent or expired one authenticates nothing, and a state-blind read finds each row (control)",
    () =>
      Effect.gen(function* reusableCode() {
        const fixture = yield* world("code-alumni");
        const personId = fixture.person.id;
        const sql = yield* SqlClient;
        const codes = yield* CodeRepository;

        const present = (built: "expired" | "unsent" | "usable") =>
          Effect.gen(function* presentCode() {
            const { hash, token } = yield* mintCode().pipe(Effect.orDie);

            const code = {
              expiresAt: built === "expired" ? lapsed : expiresAt,
              hash,
              purpose: "alumniConsent",
            } as const;

            yield* asPerson(personId, (locked) =>
              built === "unsent"
                ? issueUnsent(locked, code)
                : issueUsable(locked, code)
            );

            const principal = yield* codePrincipal(token, "alumniConsent");

            const found = yield* codes.findUsable({
              hash,
              now,
              purpose: "alumniConsent",
            });

            const rows = yield* sql<{
              readonly state: string;
            }>`select state from code where hash = ${hash}`;

            return {
              authenticates: Option.isSome(principal),
              found: Option.isSome(found),
              state: rows[0]?.state,
            };
          });

        const refused = { authenticates: false, found: false };

        assert.deepStrictEqual(yield* present("unsent"), {
          ...refused,
          state: "Unsent",
        });

        assert.deepStrictEqual(yield* present("expired"), {
          ...refused,
          state: "Usable",
        });

        assert.deepStrictEqual(yield* present("usable"), {
          authenticates: true,
          found: true,
          state: "Usable",
        });
      })
  );

  it.effect(
    "spec 0024 F5: an Unsent or a Used code authenticates nothing in any purpose, an expired one neither, and only a Usable unexpired code does; a state-blind read finds each row (control)",
    () =>
      Effect.gen(function* unusableNeverAuthenticates() {
        const fixture = yield* world("code-unusable");
        const personId = fixture.person.id;
        const sql = yield* SqlClient;
        const codes = yield* CodeRepository;

        /**
         * A code of `purpose` that the store holds in `built` (`expired`: acknowledged and past its expiry), presented
         * the three ways that a code is asked for: as a principal, as a read, and as a spend. The state-blind SQL read is
         * the control: the row is there whatever the answers are, so a refusal is the state's and not an absent row.
         */
        const present = (purpose: SingleUsePurpose, built: Built) =>
          Effect.gen(function* presentCode() {
            const { hash, token } = yield* mintCode().pipe(Effect.orDie);

            yield* asPerson(personId, (locked) =>
              storeAs(locked, built, {
                expiresAt: built === "expired" ? lapsed : expiresAt,
                hash,
                purpose,
              })
            );

            const principal = yield* codePrincipal(token, purpose);
            const found = yield* codes.findUsable({ hash, now, purpose });

            const rows = yield* sql<{
              readonly state: string;
            }>`select state from code where hash = ${hash}`;

            const spent = yield* asPerson(personId, (locked) =>
              codes.consume(locked, { hash, now, purpose })
            );

            return {
              authenticates: Option.isSome(principal),
              found: Option.isSome(found),
              spent,
              state: rows[0]?.state,
            };
          });

        const refused = { authenticates: false, found: false, spent: false };

        const accepted = {
          authenticates: true,
          found: true,
          spent: true,
          state: "Usable",
        };

        const expectations = [
          ["unsent", { ...refused, state: "Unsent" }],
          ["used", { ...refused, state: "Used" }],
          ["expired", { ...refused, state: "Usable" }],
          ["usable", accepted],
        ] as const;

        // Activation needs an Invited account, and a reset an Active one.
        yield* asPerson(personId, (locked) =>
          AccountRepository.use((accounts) => accounts.invite(locked))
        );

        for (const [built, expected] of expectations) {
          assert.deepStrictEqual(
            yield* present("activation", built),
            expected,
            `activation, ${built}`
          );
        }

        yield* asPerson(personId, (locked) =>
          moveAccount(locked, "activateAccount", "Invited")
        );

        for (const [built, expected] of expectations) {
          assert.deepStrictEqual(
            yield* present("resetPassword", built),
            expected,
            `resetPassword, ${built}`
          );
        }
      })
  );

  it.effect(
    "each code principal has exactly its command, subject and transition state",
    () =>
      Effect.gen(function* codeStateProperty() {
        const fixture = yield* world("code-state");

        yield* asPerson(fixture.person.id, (locked) =>
          AccountRepository.use((accounts) => accounts.invite(locked))
        );

        for (const state of ["Invited", "Active", "Deactivated"] as const) {
          if (state === "Active") {
            yield* asPerson(fixture.person.id, (locked) =>
              moveAccount(locked, "activateAccount", "Invited")
            );
          }

          if (state === "Deactivated") {
            yield* asPerson(fixture.person.id, (locked) =>
              moveAccount(locked, "deactivateAccount", "Active")
            );
          }

          yield* Effect.forEach(
            ["activation", "resetPassword"] satisfies readonly CodePurpose[],
            (purpose) => checkPurpose(fixture.person.id, state, purpose),
            { discard: true }
          );
        }
      })
  );
  it.effect(
    "RULE-202: 300 rounds of racing deactivations preserve the last Active admin",
    () =>
      Effect.gen(function* lastAdminRace() {
        const fixture = yield* world("admin-race");
        const accounts = yield* AccountRepository;
        const people = yield* PersonRepository;
        const sql = yield* SqlClient;

        const actor = Principal.cases.Person.make({
          adminUntil: expiresAt,
          memberships: [],
          personId: PersonId.make(900_001),
        });

        for (const round of Arr.range(1, RACE_ROUNDS)) {
          const pair = yield* Effect.forEach(
            ["left", "right"] as const,
            (side) =>
              transactional(
                people.create({
                  email: EmailAddress.make(
                    `admin-${round}-${side}@example.org`
                  ),
                  fieldOfStudyId: fixture.fieldOfStudy.id,
                  name: `Admin ${round} ${side}`,
                })
              )
          );

          for (const person of pair) {
            yield* activeAdmin(person.id, expiresAt);
          }

          const outcomes = yield* Effect.all(
            Arr.map(pair, (person) =>
              Effect.exit(
                transactional(
                  AccountEndpoints.deactivateAccount({
                    personId: person.id,
                  }).pipe(Effect.provideService(CurrentPrincipal, actor))
                )
              )
            ),
            { concurrency: "unbounded" }
          );

          const report = raceReport(round, outcomes);
          const losers = Arr.filter(outcomes, Exit.isFailure);
          assert.strictEqual(
            Arr.filter(outcomes, Exit.isSuccess).length,
            1,
            report
          );
          assert.strictEqual(losers.length, 1, report);

          for (const loser of losers) {
            assert.isTrue(
              Option.exists(
                Exit.findErrorOption(loser),
                Predicate.isTagged("Conflict")
              ),
              report
            );
          }

          const states = yield* Effect.forEach(pair, (person) =>
            accounts.find(person.id)
          );

          assert.strictEqual(
            Arr.filter(
              states,
              (entry) =>
                Option.isSome(entry) &&
                Predicate.isTagged(entry.value.state, "Active")
            ).length,
            1,
            report
          );

          for (const person of pair) {
            yield* sql`delete from admin_grant where person_id = ${person.id}`;
            yield* sql`delete from account where person_id = ${person.id}`;
          }
        }
      }),
    120_000
  );
});
