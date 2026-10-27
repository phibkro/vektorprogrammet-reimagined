/**
 * Spec 0006b R2: an Active administrator is always left, however two commands interleave. `deactivateAccount` (of an
 * account) and `deleteAdminGrant` (of a place) decide on every administrator, and each used to lock only the person that it changes:
 * two administrators that deactivate each other's account and revoke each other's place at once were each told that
 * another one is left, and nobody was. Both now lock the admin list first and read through its token, so the command
 * that decides second sees the result of the first. Each race runs in rounds of fresh state, prints every loser's full
 * Cause when it fails, and names its round count; the control runs the same race by hand without the shared lock, and
 * must show the violation.
 */
import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import {
  ADMIN_LIST_ID,
  AccountEndpoints,
  AccountRepository,
  AdminGrantRepository,
  CurrentPrincipal,
  PasswordHasher,
  Principal,
  SiteOrigin,
  TeamsEndpoints,
  ValidationFailed,
} from "@vektorprogrammet/domain";
import type {
  AdminGrantId,
  FieldOfStudyId,
  PersonId,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { transactional } from "../src/index.ts";
import {
  activateAccount,
  activeAdmin,
  moveAccount,
  noAdmins,
} from "./support/accountsWorld.ts";
import { postgresDatabase } from "./support/database.ts";
import {
  describeExit,
  meetsHeldLock,
  raceReport,
  raceTwo,
} from "./support/race.ts";
import {
  asPerson,
  lockPerson,
  twoPeople,
  world,
} from "./support/teamsWorld.ts";

/** The bound of the race: many rounds, because one concurrent attempt proves nothing (spec 0006 R6). */
const RACE_ROUNDS = 300;

/** The rounds of the control. Its interleaving is forced, so every round shows the violation; a few are enough. */
const CONTROL_ROUNDS = 30;

const STRESS_TIMEOUT_MS = 180_000;

/** Where a place ends: the endpoints take the instant as text, as a request carries it. */
const UNTIL = "2099-01-01T00:00:00.000Z";

const expiresAt = DateTime.makeUnsafe(UNTIL);

/** How long a deactivation waits between its decision and its write, so that the other command runs in between. */
const HELD_BACK = "15 millis";

/** An administrator as a request carries it: the principal was built when the request began, and is not rechecked. */
const adminPrincipal = (personId: PersonId) =>
  Principal.cases.Person.make({
    adminUntil: expiresAt,
    memberships: [],
    personId,
  });

/** `actor` deactivates the account of `personId`, in a transaction of its own. */
const deactivateAs = (actor: PersonId, personId: PersonId) =>
  transactional(
    AccountEndpoints.deactivateAccount({ personId }).pipe(
      Effect.provideService(CurrentPrincipal, adminPrincipal(actor))
    )
  );

const reactivateAs = (actor: PersonId, personId: PersonId) =>
  transactional(
    AccountEndpoints.reactivateAccount({ personId }).pipe(
      Effect.provideService(CurrentPrincipal, adminPrincipal(actor))
    )
  );

const grantAs = (actor: PersonId, personId: PersonId) =>
  transactional(
    TeamsEndpoints.createAdminGrant({ personId, until: UNTIL }).pipe(
      Effect.provideService(CurrentPrincipal, adminPrincipal(actor))
    )
  );

/** `actor` revokes the place `id`, in a transaction of its own. */
const revokeAs = (actor: PersonId, id: AdminGrantId) =>
  transactional(
    TeamsEndpoints.deleteAdminGrant({ id }).pipe(
      Effect.provideService(CurrentPrincipal, adminPrincipal(actor))
    )
  );

/** The write of an account's transition is held back, so that the decision of the other command falls before it. */
const heldBack = Layer.effect(
  AccountRepository,
  Effect.gen(function* heldBackAccounts() {
    const live = yield* AccountRepository;

    return AccountRepository.of({
      ...live,
      transition: (locked, change) =>
        Effect.andThen(
          Effect.sleep(HELD_BACK),
          live.transition(locked, change)
        ),
    });
  })
);

/** The places that count, read as the commands read them: valid, and held by an Active account. */
const countingPlaces = Effect.gen(function* countingPlacesRead() {
  const sql = yield* SqlClient;

  return yield* sql<{
    readonly id: number;
    readonly personId: number;
  }>`select g.id, g.person_id as "personId" from admin_grant g
    join account a on a.person_id = g.person_id
    where a.state = 'Active' and g.until > now()`;
});

/** Whether the exit failed with the typed error of this tag. */
const refusedWith = (exit: Exit.Exit<unknown, unknown>, tag: string) =>
  Option.exists(Exit.findErrorOption(exit), Predicate.isTagged(tag));

/** Whether the exit is the refusal of the last place by `deleteAdminGrant`: a `ValidationFailed` that names `id`. */
const refusedAsLastPlace = (exit: Exit.Exit<unknown, unknown>) =>
  Option.exists(
    Exit.findErrorOption(exit),
    (refusal) =>
      Schema.is(ValidationFailed)(refusal) &&
      Arr.some(refusal.issues, (issue) => Arr.contains(issue.path, "id"))
  );

/** What went wrong in a round, with every loser's Cause; nothing when the round kept the rule. */
const problemsOf = (
  round: number,
  outcome: {
    readonly counting: number;
    readonly deactivated: Exit.Exit<unknown, unknown>;
    readonly revoked: Exit.Exit<unknown, unknown>;
  }
) => {
  const exits = [outcome.deactivated, outcome.revoked];
  const wins = Arr.filter(exits, Exit.isSuccess).length;

  const found = [
    ...(wins === 1 ? [] : [`${wins} commands succeeded, not one`]),
    ...(Exit.isSuccess(outcome.deactivated) ||
    refusedWith(outcome.deactivated, "Conflict")
      ? []
      : ["the deactivation lost with something other than a Conflict"]),
    ...(Exit.isSuccess(outcome.revoked) || refusedAsLastPlace(outcome.revoked)
      ? []
      : [
          "the revocation lost with something other than ValidationFailed on id",
        ]),
    ...(outcome.counting === 1
      ? []
      : [
          `${outcome.counting} places held by an Active account are left, not one`,
        ]),
  ];

  return found.length === 0
    ? []
    : [`${Arr.join(found, "; ")}\n${raceReport(round, exits)}`];
};

/** Fresh state with two Active administrators who hold one place each: both people, and the left one's place. */
const twoAdministrators = Effect.fnUntraced(function* twoAdministrators(
  fieldOfStudyId: FieldOfStudyId,
  tag: string
) {
  yield* noAdmins;
  const [left, right] = yield* twoPeople(fieldOfStudyId, tag);
  const leftPlace = yield* activeAdmin(left.id, expiresAt);
  yield* activeAdmin(right.id, expiresAt);

  return { left, leftPlace, right };
});

/**
 * One round in fresh state: two Active administrators with one place each. The first one deactivates the account of
 * the other one while the other one revokes the first one's place. Whichever command decides second must see the
 * result of the first: one of them succeeds, the other is refused, and an Active account still holds a place.
 */
const adminRound = Effect.fnUntraced(function* adminRound(
  fieldOfStudyId: FieldOfStudyId,
  tag: string,
  held: boolean
) {
  const { left, leftPlace, right } = yield* twoAdministrators(
    fieldOfStudyId,
    tag
  );

  const commands = raceTwo(
    deactivateAs(left.id, right.id),
    revokeAs(right.id, leftPlace.id)
  );

  const [deactivated, revoked] = yield* held
    ? Effect.provide(commands, heldBack)
    : commands;

  return {
    counting: Arr.length(yield* countingPlaces),
    deactivated,
    revoked,
  };
});

/** `RACE_ROUNDS` rounds, one after the other; the problems of all of them. */
const adminRounds = Effect.fnUntraced(function* adminRounds(
  fieldOfStudyId: FieldOfStudyId,
  prefix: string,
  held: boolean
) {
  const problems = yield* Effect.forEach(
    Arr.range(1, RACE_ROUNDS),
    (round) =>
      Effect.map(
        adminRound(fieldOfStudyId, `${prefix}${round}`, held),
        (outcome) => problemsOf(round, outcome)
      ),
    { concurrency: 1 }
  );

  return Arr.flatten(problems);
});

/** One side of the old protocol decides first, the other one decides, and only then does either of them write. */
interface Barrier {
  readonly mine: Deferred.Deferred<null>;
  readonly theirs: Deferred.Deferred<null>;
}

/** This command has decided; it writes only once the other one has decided too. */
const decided = (barrier: Barrier) =>
  Effect.andThen(
    Deferred.succeed(barrier.mine, null),
    Deferred.await(barrier.theirs)
  );

/**
 * The control: the commands as they were decided before R2, by hand. Each locks only the person that it changes, reads
 * the places that count and decides, waits until the other has decided too, and writes. The wait makes the
 * interleaving that a slow request makes by chance happen in every round.
 */
const deactivateAlone = (personId: PersonId, barrier: Barrier) =>
  transactional(
    Effect.gen(function* deactivateUnderPersonLock() {
      const sql = yield* SqlClient;
      yield* sql`select id from person where id = ${personId} for no key update`;
      const places = yield* countingPlaces;
      yield* decided(barrier);

      if (Arr.some(places, (place) => place.personId !== personId)) {
        yield* sql`update account set state = 'Deactivated' where person_id = ${personId}`;
      }
    })
  );

const revokeAlone = (holder: PersonId, id: number, barrier: Barrier) =>
  transactional(
    Effect.gen(function* revokeUnderHolderLock() {
      const sql = yield* SqlClient;
      yield* sql`select id from person where id = ${holder} for no key update`;
      const places = yield* countingPlaces;
      yield* decided(barrier);

      if (Arr.some(places, (place) => place.id !== id)) {
        yield* sql`delete from admin_grant where id = ${id}`;
      }
    })
  );

/** One round of the control; the number of places that an Active account holds afterwards. */
const aloneRound = Effect.fnUntraced(function* aloneRound(
  fieldOfStudyId: FieldOfStudyId,
  tag: string
) {
  const { left, leftPlace, right } = yield* twoAdministrators(
    fieldOfStudyId,
    tag
  );

  const leftDecided = yield* Deferred.make<null>();
  const rightDecided = yield* Deferred.make<null>();

  yield* raceTwo(
    deactivateAlone(right.id, { mine: leftDecided, theirs: rightDecided }),
    revokeAlone(left.id, leftPlace.id, {
      mine: rightDecided,
      theirs: leftDecided,
    })
  );

  return Arr.length(yield* countingPlaces);
});

/**
 * Holds the admin list's row lock in a transaction of its own, starts `command`, and reports whether the command was
 * waiting for that lock, and how it ended once the lock was let go. A command that does not lock the list does not wait.
 */
const meetsHeldList = <A, E, R>(command: Effect.Effect<A, E, R>) =>
  meetsHeldLock(
    Effect.flatMap(
      SqlClient,
      (sql) =>
        sql`select id from admin_list where id = ${ADMIN_LIST_ID} for no key update`
    ),
    "%admin_list%",
    command
  );

/**
 * What a meeting with the held list showed: whether the command waited, was still running, what the waiting backend had
 * written by then (the tables it held a write lock on, and whether it held a transaction id), and whether it succeeded.
 */
const summarized = (
  name: string,
  meeting: {
    readonly exit: Exit.Exit<unknown, unknown>;
    readonly hasTransactionId: boolean;
    readonly stillRunning: boolean;
    readonly waiting: number;
    readonly wrote: readonly string[];
  }
) =>
  [
    name,
    meeting.waiting,
    meeting.stillRunning,
    meeting.wrote,
    meeting.hasTransactionId,
    Exit.isSuccess(meeting.exit) ? "succeeded" : describeExit(meeting.exit),
  ] as const;

layer(
  Layer.mergeAll(
    postgresDatabase().pipe(Layer.provideMerge(NodeServices.layer)),
    Layer.mock(PasswordHasher, {}),
    Layer.succeed(SiteOrigin)("https://vektorprogrammet.test")
  ),
  { excludeTestServices: true }
)("spec 0006b R2: an Active administrator is always left", (it) => {
  it.effect(
    `${RACE_ROUNDS} rounds of a deactivation and a revocation at once: one wins, the loser is refused with its typed error, and an Active account still holds a place`,
    () =>
      Effect.gen(function* deactivateAgainstRevoke() {
        const { fieldOfStudy } = yield* world("listrace");

        assert.deepStrictEqual(
          yield* adminRounds(fieldOfStudy.id, "race", false),
          []
        );
      }),
    STRESS_TIMEOUT_MS
  );

  it.effect(
    `${RACE_ROUNDS} rounds of the same race with every deactivation's write held back ${HELD_BACK}, so that the other command always decides in between: the second decision still sees the first`,
    () =>
      Effect.gen(function* deactivateAgainstRevokeHeldBack() {
        const { fieldOfStudy } = yield* world("listheld");

        assert.deepStrictEqual(
          yield* adminRounds(fieldOfStudy.id, "held", true),
          []
        );
      }),
    STRESS_TIMEOUT_MS
  );

  it.effect(
    `negative control: the same two decisions under each person's own lock only, the protocol before R2, leave no Active administrator with a place in all ${CONTROL_ROUNDS} rounds`,
    () =>
      Effect.gen(function* oldProtocol() {
        const { fieldOfStudy } = yield* world("listalone");

        const remaining = yield* Effect.forEach(
          Arr.range(1, CONTROL_ROUNDS),
          (round) => aloneRound(fieldOfStudy.id, `alone${round}`),
          { concurrency: 1 }
        );

        assert.deepStrictEqual(
          remaining,
          Arr.makeBy(CONTROL_ROUNDS, () => 0),
          "without the shared lock both commands were told that another administrator is left"
        );
      }),
    STRESS_TIMEOUT_MS
  );

  it.effect(
    "a deactivated administrator's place does not count: its stale principal can neither revoke the last Active administrator's place nor deactivate the last Active administrator",
    () =>
      Effect.gen(function* staleAdministrator() {
        const grants = yield* AdminGrantRepository;
        const sql = yield* SqlClient;
        const { fieldOfStudy } = yield* world("liststale");
        const [active, gone] = yield* twoPeople(fieldOfStudy.id, "liststale");

        yield* noAdmins;
        const place = yield* activeAdmin(active.id, expiresAt);
        yield* activeAdmin(gone.id, expiresAt);

        // `gone` was an administrator when its request began; then its account was deactivated.
        yield* asPerson(gone.id, (locked) =>
          moveAccount(locked, "deactivateAccount", "Active")
        );

        const everyValid = yield* sql<{
          readonly places: number;
        }>`select count(*)::int as places from admin_grant where until > now()`;

        const revoked = yield* Effect.exit(revokeAs(gone.id, place.id));

        const deactivated = yield* Effect.exit(
          deactivateAs(gone.id, active.id)
        );

        assert.strictEqual(
          everyValid[0]?.places,
          2,
          "control: counting every valid place, as the rule did before R2, another one is left in both decisions"
        );
        assert.isTrue(refusedAsLastPlace(revoked), describeExit(revoked));
        assert.isTrue(
          refusedWith(deactivated, "Conflict"),
          describeExit(deactivated)
        );

        assert.isTrue(
          Arr.some(yield* grants.list, (grant) => grant.id === place.id),
          "the place is still there"
        );
        assert.deepStrictEqual(
          Arr.length(yield* countingPlaces),
          1,
          "an Active account still holds a place"
        );
      })
  );

  it.effect(
    "deactivateAccount, reactivateAccount, createAdminGrant and deleteAdminGrant wait for the admin list's lock before they write anything; a command that does not lock the list does not wait",
    () =>
      Effect.gen(function* waitsForTheList() {
        const { fieldOfStudy, person: holder } = yield* world("listwait");
        const [boss, subject] = yield* twoPeople(fieldOfStudy.id, "listwait");
        const [away, newcomer] = yield* twoPeople(fieldOfStudy.id, "listwait2");

        // The boss acts. The subject, the holder and the boss are Active administrators, the away is deactivated.
        yield* noAdmins;
        yield* activeAdmin(boss.id, expiresAt);
        yield* activeAdmin(subject.id, expiresAt);
        const holdersPlace = yield* activeAdmin(holder.id, expiresAt);
        yield* asPerson(away.id, activateAccount);
        yield* asPerson(away.id, (locked) =>
          moveAccount(locked, "deactivateAccount", "Active")
        );

        const observed = [
          summarized(
            "deactivateAccount",
            yield* meetsHeldList(deactivateAs(boss.id, subject.id))
          ),
          summarized(
            "reactivateAccount",
            yield* meetsHeldList(reactivateAs(boss.id, away.id))
          ),
          summarized(
            "createAdminGrant",
            yield* meetsHeldList(grantAs(boss.id, newcomer.id))
          ),
          summarized(
            "deleteAdminGrant",
            yield* meetsHeldList(revokeAs(boss.id, holdersPlace.id))
          ),
          summarized(
            "a person's lock alone",
            yield* meetsHeldList(transactional(lockPerson(newcomer.id)))
          ),
        ];

        assert.deepStrictEqual(observed, [
          ["deactivateAccount", 1, true, [], false, "succeeded"],
          ["reactivateAccount", 1, true, [], false, "succeeded"],
          ["createAdminGrant", 1, true, [], false, "succeeded"],
          ["deleteAdminGrant", 1, true, [], false, "succeeded"],
          ["a person's lock alone", 0, false, [], false, "succeeded"],
        ]);
      }),
    STRESS_TIMEOUT_MS
  );
});
