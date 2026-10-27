/**
 * The teams repositories (spec 0006) on PGlite behind the same `RepositoriesLayer` as production: the constraints
 * that map to `AlreadyExists`, the conditional updates that turn a lost race into `Conflict`, the reads, the digest
 * ledger and the principal directory. The real-PostgreSQL races are `teams.postgres.test.ts`.
 */
import { assert, layer } from "@effect/vitest";
import {
  AccountRepository,
  AdminGrantRepository,
  DigestLedger,
  CompanyEmail,
  EmailAddress,
  MembershipRepository,
  PersonRepository,
  PositionRepository,
  PrincipalDirectory,
  TeamRepository,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect, Exit, Option } from "effect";

import { transactional } from "../src/index.ts";
import {
  activateAccount,
  activeAdmin,
  moveAccount,
  noAdmins,
} from "./support/accountsWorld.ts";
import { pgliteDatabase } from "./support/database.ts";
import {
  asPerson,
  grantPlace,
  placeMembership,
  revokePlace,
  semester,
  world,
} from "./support/teamsWorld.ts";

const HOST_2026 = semester("HOST", 2026);

const VAR_2027 = semester("VAR", 2027);

const HOST_2027 = semester("HOST", 2027);

const NOW = DateTime.makeUnsafe("2026-10-15T10:00:00Z");

const LATER = DateTime.makeUnsafe("2099-12-31T23:59:59Z");

layer(pgliteDatabase)("the teams repositories on PGlite", (it) => {
  it.effect(
    "the position value list starts with the legacy fixtures, Leder and Medlem",
    () =>
      Effect.gen(function* effectProgram() {
        const positions = yield* (yield* PositionRepository).list;

        assert.deepStrictEqual(
          Arr.map(positions, (position) => position.name),
          ["Leder", "Medlem"]
        );
      })
  );

  it.effect(
    "a person's department follows their field, and only one person can verify an e-mail",
    () =>
      Effect.gen(function* effectProgram() {
        const { department, fieldOfStudy, person } = yield* world("alfa");
        const people = yield* PersonRepository;

        assert.strictEqual(person.departmentId, department.id);

        const other = yield* transactional(
          people.create({
            email: person.email,
            fieldOfStudyId: fieldOfStudy.id,
            name: "Annen Person",
          })
        );

        const accounts = yield* AccountRepository;
        yield* asPerson(person.id, (locked) => accounts.verifyEmail(locked));

        const collision = yield* Effect.flip(
          asPerson(other.id, (locked) => accounts.verifyEmail(locked))
        );

        assert.strictEqual(collision._tag, "AlreadyExists");
        assert.sameMembers(
          Arr.map(yield* people.list(department.id), (found) => found.id),
          [person.id, other.id]
        );
        assert.deepStrictEqual(yield* people.findById(person.id), person);
      })
  );

  it.effect("the database keeps e-mail addresses in lower case", () =>
    Effect.gen(function* effectProgram() {
      const { fieldOfStudy } = yield* world("beta");

      const exit = yield* Effect.exit(
        transactional(
          (yield* PersonRepository).create({
            email: EmailAddress.make("Stor.Bokstav@example.org"),
            fieldOfStudyId: fieldOfStudy.id,
            name: "Stor Bokstav",
          })
        )
      );

      assert.isTrue(Exit.hasDies(exit));
    })
  );

  it.effect(
    "RULE-157: a team name is unique within a department, and a team is deactivated, never deleted",
    () =>
      Effect.gen(function* effectProgram() {
        const { department, team } = yield* world("gamma");
        const teams = yield* TeamRepository;

        const duplicate = yield* Effect.flip(
          transactional(
            teams.create({
              defaultTerm: 1,
              departmentId: department.id,
              function: "it",
              groupEmail: null,
              name: team.name,
            })
          )
        );

        const renamedToItself = yield* transactional(
          teams.update(team.id, {
            defaultTerm: 1,
            function: "it",
            groupEmail: null,
            name: team.name,
          })
        );

        const deactivated = yield* teams.deactivate(team.id);

        assert.strictEqual(duplicate._tag, "AlreadyExists");
        assert.strictEqual(renamedToItself.function, "it");
        assert.isFalse(deactivated.active);
        assert.deepStrictEqual(
          Arr.map(yield* teams.list(department.id), (found) => found.id),
          [team.id]
        );
      })
  );

  it.effect(
    "team group addresses persist and a duplicate is a typed conflict",
    () =>
      Effect.gen(function* groupAddresses() {
        const { department, team } = yield* world("workspace");
        const teams = yield* TeamRepository;

        const groupEmail = CompanyEmail.make(
          "team-workspace@vektorprogrammet.no"
        );

        const assigned = yield* transactional(
          teams.update(team.id, {
            defaultTerm: 2,
            function: "recruitment",
            groupEmail,
            name: team.name,
          })
        );

        assert.strictEqual(assigned.groupEmail, groupEmail);

        const refused = yield* Effect.flip(
          transactional(
            teams.create({
              defaultTerm: 1,
              departmentId: department.id,
              function: "it",
              groupEmail,
              name: "Other group",
            })
          )
        );

        assert.strictEqual(refused._tag, "Conflict");
        assert.include(refused.message, "allerede i bruk");
        assert.strictEqual(
          (yield* teams.findById(team.id)).groupEmail,
          groupEmail
        );
      })
  );

  it.effect(
    "a person's terms in one team never overlap; a term that starts the semester after another ends is fine",
    () =>
      Effect.gen(function* effectProgram() {
        const { memberPosition, person, team } = yield* world("delta");

        const who = {
          personId: person.id,
          positionId: memberPosition,
          teamId: team.id,
        };

        const first = yield* placeMembership(who, {
          end: VAR_2027,
          start: HOST_2026,
        });

        const overlapping = yield* Effect.flip(
          placeMembership(who, { end: HOST_2027, start: VAR_2027 })
        );

        const next = yield* placeMembership(who, {
          end: HOST_2027,
          start: HOST_2027,
        });

        const memberships = yield* MembershipRepository;

        assert.strictEqual(overlapping._tag, "AlreadyExists");
        assert.deepStrictEqual(
          Arr.map(yield* memberships.listByTeam(team.id), (row) => row.id),
          [first.id, next.id]
        );
        assert.deepStrictEqual(
          Arr.map(yield* memberships.listByPerson(person.id), (row) => row.id),
          [next.id, first.id]
        );
      })
  );

  it.effect(
    "activeIn answers one definition of active: start ≤ the semester ≤ end, with the names the digest needs",
    () =>
      Effect.gen(function* effectProgram() {
        const { department, leaderPosition, person, team } =
          yield* world("epsilon");

        const planned = yield* placeMembership(
          { personId: person.id, positionId: leaderPosition, teamId: team.id },
          { end: HOST_2027, start: HOST_2027 },
          true
        );

        const memberships = yield* MembershipRepository;
        const before = yield* memberships.activeIn(HOST_2026);
        const active = yield* memberships.activeIn(HOST_2027);
        const row = Arr.findFirst(active, (found) => found.id === planned.id);

        assert.isFalse(Arr.some(before, (found) => found.id === planned.id));
        assert.isTrue(Option.isSome(row));

        assert.deepStrictEqual(
          Option.map(row, (found) => [
            found.teamName,
            found.personName,
            found.personEmail,
            found.departmentId,
            found.positionName,
          ]),
          Option.some([
            team.name,
            person.name,
            person.email,
            department.id,
            "Leder",
          ])
        );
      })
  );

  it.effect(
    "setEnd is a conditional update: it matches only an Active membership that still ends where the caller read it",
    () =>
      Effect.gen(function* effectProgram() {
        const { memberPosition, person, team } = yield* world("zeta");

        const created = yield* placeMembership(
          {
            personId: person.id,
            positionId: memberPosition,
            teamId: team.id,
          },
          { end: VAR_2027, start: HOST_2026 }
        );

        const memberships = yield* MembershipRepository;

        const setEnd = (change: {
          readonly activeIn: typeof HOST_2026;
          readonly newEnd: typeof HOST_2026;
          readonly observedEnd: typeof HOST_2026;
        }) =>
          asPerson(person.id, (locked) =>
            memberships.setEnd(locked, { id: created.id, ...change })
          );

        const stale = yield* Effect.flip(
          setEnd({
            activeIn: HOST_2026,
            newEnd: HOST_2027,
            observedEnd: HOST_2026,
          })
        );

        const notActive = yield* Effect.flip(
          setEnd({
            activeIn: HOST_2027,
            newEnd: HOST_2027,
            observedEnd: VAR_2027,
          })
        );

        const extended = yield* setEnd({
          activeIn: HOST_2026,
          newEnd: HOST_2027,
          observedEnd: VAR_2027,
        });

        const again = yield* Effect.flip(
          setEnd({
            activeIn: HOST_2026,
            newEnd: HOST_2027,
            observedEnd: VAR_2027,
          })
        );

        assert.deepStrictEqual(
          Arr.map([stale, notActive, again], (failure) => failure._tag),
          ["Conflict", "Conflict", "Conflict"]
        );
        assert.deepStrictEqual(extended.end, HOST_2027);
        assert.deepStrictEqual(
          (yield* memberships.findById(created.id)).end,
          HOST_2027
        );
      })
  );

  it.effect(
    "setEnd that would overlap the next term of the same person in the team is AlreadyExists",
    () =>
      Effect.gen(function* effectProgram() {
        const { memberPosition, person, team } = yield* world("eta");

        const who = {
          personId: person.id,
          positionId: memberPosition,
          teamId: team.id,
        };

        const first = yield* placeMembership(who, {
          end: HOST_2026,
          start: HOST_2026,
        });

        yield* placeMembership(who, { end: HOST_2027, start: VAR_2027 });

        const overlap = yield* Effect.flip(
          asPerson(person.id, (locked) =>
            MembershipRepository.use((memberships) =>
              memberships.setEnd(locked, {
                activeIn: HOST_2026,
                id: first.id,
                newEnd: VAR_2027,
                observedEnd: HOST_2026,
              })
            )
          )
        );

        assert.strictEqual(overlap._tag, "AlreadyExists");
      })
  );

  it.effect(
    "remove deletes a membership that has not started and still has the term the caller read, and nothing else",
    () =>
      Effect.gen(function* effectProgram() {
        const { memberPosition, person, team } = yield* world("theta");

        const planned = yield* placeMembership(
          {
            personId: person.id,
            positionId: memberPosition,
            teamId: team.id,
          },
          { end: HOST_2027, start: HOST_2027 }
        );

        const memberships = yield* MembershipRepository;
        const observed = { end: planned.end, start: planned.start };

        const changed = yield* Effect.flip(
          asPerson(person.id, (locked) =>
            memberships.remove(locked, {
              current: HOST_2026,
              id: planned.id,
              observed: { end: VAR_2027, start: HOST_2027 },
            })
          )
        );

        const started = yield* Effect.flip(
          asPerson(person.id, (locked) =>
            memberships.remove(locked, {
              current: HOST_2027,
              id: planned.id,
              observed,
            })
          )
        );

        yield* asPerson(person.id, (locked) =>
          memberships.remove(locked, {
            current: HOST_2026,
            id: planned.id,
            observed,
          })
        );

        const gone = yield* Effect.flip(memberships.findById(planned.id));

        assert.deepStrictEqual(
          Arr.map([changed, started], (failure) => failure._tag),
          ["Conflict", "Conflict"]
        );
        assert.strictEqual(gone._tag, "NotFound");
      })
  );

  it.effect(
    "the admin list: the last place that ends after the cut-off cannot be revoked, an expired place does not count",
    () =>
      Effect.gen(function* effectProgram() {
        const { person } = yield* world("iota");
        yield* noAdmins;
        const grants = yield* AdminGrantRepository;
        const cutoff = DateTime.makeUnsafe("2026-12-31T23:00:00Z");

        // Only a place that an Active account holds counts as the last one.
        yield* asPerson(person.id, activateAccount);

        const expired = yield* grantPlace(person.id, {
          grantedBy: null,
          until: DateTime.makeUnsafe("2026-08-31T00:00:00Z"),
        });

        const only = yield* grantPlace(person.id, {
          grantedBy: null,
          until: LATER,
        });

        const last = yield* revokePlace(person.id, only.id, cutoff);
        const dropped = yield* revokePlace(person.id, expired.id, cutoff);

        const missing = yield* Effect.flip(
          revokePlace(person.id, expired.id, cutoff)
        );

        assert.strictEqual(last, "last");
        assert.strictEqual(dropped, "revoked");
        assert.strictEqual(missing._tag, "NotFound");
        assert.deepStrictEqual(
          Arr.map(yield* grants.list, (grant) => grant.id),
          [only.id]
        );
      })
  );

  it.effect(
    "a place that a deactivated account holds does not count: the list is never left with no Active administrator",
    () =>
      Effect.gen(function* effectProgram() {
        const { fieldOfStudy, person } = yield* world("iota2");
        yield* noAdmins;
        const cutoff = DateTime.makeUnsafe("2026-12-31T23:00:00Z");

        const other = yield* PersonRepository.use((people) =>
          transactional(
            people.create({
              email: EmailAddress.make("iota2.other@example.org"),
              fieldOfStudyId: fieldOfStudy.id,
              name: "Annen administrator",
            })
          )
        );

        const mine = yield* activeAdmin(person.id, LATER);
        const theirs = yield* activeAdmin(other.id, LATER);

        yield* asPerson(other.id, (locked) =>
          moveAccount(locked, "deactivateAccount", "Active")
        );

        const refused = yield* revokePlace(person.id, mine.id, cutoff);
        const allowed = yield* revokePlace(other.id, theirs.id, cutoff);

        assert.strictEqual(refused, "last");
        assert.strictEqual(allowed, "revoked");
      })
  );

  it.effect("the digest ledger gives a leader's semester out once", () =>
    Effect.gen(function* effectProgram() {
      const { person } = yield* world("kappa");
      const ledger = yield* DigestLedger;

      assert.deepStrictEqual(
        [
          yield* ledger.claim(person.id, HOST_2026),
          yield* ledger.claim(person.id, HOST_2026),
          yield* ledger.claim(person.id, VAR_2027),
        ],
        [true, false, true]
      );
    })
  );

  it.effect(
    "the principal directory loads a person's active memberships and valid admin places in one read",
    () =>
      Effect.gen(function* effectProgram() {
        const { department, leaderPosition, person, team } =
          yield* world("lambda");

        yield* placeMembership(
          { personId: person.id, positionId: leaderPosition, teamId: team.id },
          { end: VAR_2027, start: HOST_2026 },
          true
        );

        yield* grantPlace(person.id, { grantedBy: null, until: LATER });

        const directory = yield* PrincipalDirectory;

        const found = yield* directory.byName(person.name, {
          current: HOST_2026,
          now: NOW,
        });

        const later = yield* directory.byName(person.name, {
          current: HOST_2027,
          now: DateTime.makeUnsafe("2100-01-01T00:00:00Z"),
        });

        const missing = yield* directory.byName("Finnes Ikke", {
          current: HOST_2026,
          now: NOW,
        });

        assert.isTrue(Option.isNone(missing));
        assert.isTrue(Option.isSome(found));
        assert.isTrue(Option.isSome(later));

        if (Option.isSome(found)) {
          assert.strictEqual(found.value.personId, person.id);
          assert.deepStrictEqual(found.value.memberships, [
            {
              departmentId: department.id,
              function: "recruitment",
              leader: true,
              teamId: team.id,
            },
          ]);
          assert.isDefined(found.value.adminUntil);
        }

        if (Option.isSome(later)) {
          assert.deepStrictEqual(later.value.memberships, []);
          assert.isUndefined(later.value.adminUntil);
        }

        assert.isTrue(Arr.contains(yield* directory.names(50), person.name));
      })
  );
});
