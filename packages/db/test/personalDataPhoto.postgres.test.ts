/**
 * Spec 0007b R2 item 12: `setPhoto` stores a photo only under a current `photo` consent, and only the person can give
 * that consent, by passing it on their own call. A leader (and an administrator, whom the kernel's `Admin` row lets run
 * every command of a person) who sets the photo of someone who has not consented is refused, and so is one who passes the
 * consent for them: a consent is the person's own statement. Removing the photo withdraws the consent, so the next photo
 * needs a new one. Each refusal changes nothing (the snapshot of the catalog's tables is the same), and each has its
 * control: the same call that is allowed once the person has consented.
 */
import { assert, layer } from "@effect/vitest";
import {
  Conflict,
  DepartmentId,
  PersonId,
  PersonalDataEndpoints,
  Principal,
  TeamId,
  ValidationFailed,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { postgresDatabase } from "./support/database.ts";
import { failedWith, refusalOf } from "./support/failures.ts";
import {
  adminPrincipal,
  countWhere,
  runAs,
  selfPrincipal,
} from "./support/personalDataActors.ts";
import { nothing, seedPerson } from "./support/personData.ts";
import type { Seeded } from "./support/personData.ts";
import { describeExit } from "./support/race.ts";
import { snapshot } from "./support/snapshot.ts";

const NOW = DateTime.makeUnsafe("2026-10-27T12:00:00Z");

/** A person with a public file to use as the photo. */
const withFile = (tag: string) =>
  seedPerson(tag, { ...nothing, file: true }, NOW);

/** The key of the one public file that `seedPerson` registered for the person. */
const fileKeyOf = Effect.fnUntraced(function* fileKeyOf(who: Seeded) {
  const sql = yield* SqlClient;

  const [row] = yield* sql<{
    readonly key: string;
  }>`select key from public_file where uploaded_by = ${who.personId}`;

  return row?.key ?? "";
});

/** A leader of the department of `who`: the grant table gives `setPhoto` to a leader for their own department. */
const leaderOf = Effect.fnUntraced(function* leaderOf(
  leader: Seeded,
  who: Seeded
) {
  const sql = yield* SqlClient;

  const [row] = yield* sql<{
    readonly department_id: number;
  }>`select department_id from team where id = ${who.teamId}`;

  return Principal.cases.Person.make({
    memberships: [
      {
        departmentId: DepartmentId.make(row?.department_id ?? 0),
        function: "recruitment",
        leader: true,
        teamId: TeamId.make(who.teamId),
      },
    ],
    personId: PersonId.make(leader.personId),
  });
});

const photoOf = Effect.fnUntraced(function* photoOf(who: Seeded) {
  const sql = yield* SqlClient;

  const [row] = yield* sql<{
    readonly photo_key: string | null;
  }>`select photo_key from person where id = ${who.personId}`;

  return row?.photo_key ?? null;
});

/** The photo consent rows of the person (at most one): the version of the text, and whether it is withdrawn. */
const photoConsentOf = Effect.fnUntraced(function* photoConsentOf(who: Seeded) {
  const sql = yield* SqlClient;

  const rows = yield* sql<{
    readonly text_version: number;
    readonly withdrawn: boolean;
  }>`select text_version, withdrawn_at is not null as withdrawn from consent
    where person_id = ${who.personId} and kind = 'photo'`;

  return Arr.map(rows, ({ text_version, withdrawn }) => ({
    text_version,
    withdrawn,
  }));
});

const setPhoto = (
  actor: Principal,
  personId: number,
  payload: { readonly consent?: boolean; readonly photo: string | null }
) => runAs(actor, PersonalDataEndpoints.setPhoto({ personId, ...payload }));

layer(postgresDatabase(), { excludeTestServices: true })(
  "spec 0007b: a photo needs the person's own consent",
  (it) => {
    it.effect(
      "a leader or an administrator who sets the photo of a person who has not consented is refused, and so is one who passes the consent for them; nothing changes",
      () =>
        Effect.gen(function* noConsent() {
          const ola = yield* withFile("phola");
          const lise = yield* seedPerson("phlise", nothing, NOW);
          const ada = yield* seedPerson("phada", nothing, NOW);
          const key = yield* fileKeyOf(ola);
          const leader = yield* leaderOf(lise, ola);
          const before = yield* snapshot;

          for (const [who, actor] of [
            ["a leader", leader],
            ["an administrator", adminPrincipal(ada.personId)],
          ] as const) {
            for (const [how, payload] of [
              ["without the consent", { photo: key }],
              ["passing the consent", { consent: true, photo: key }],
            ] as const) {
              const exit = yield* Effect.exit(
                setPhoto(actor, ola.personId, payload)
              );

              assert.isTrue(
                failedWith(exit, Conflict),
                `${who}, ${how}: ${describeExit(exit)}`
              );

              assert.include(refusalOf(exit), "samtykke");
            }
          }

          assert.deepStrictEqual(yield* snapshot, before);
          assert.isNull(yield* photoOf(ola));
        })
    );

    it.effect(
      "the person gives the consent with the file: the photo is stored and the consent is recorded as given by them; a leader may then set another photo, and the consent stays",
      () =>
        Effect.gen(function* ownConsent() {
          const ola = yield* withFile("phown");
          const lise = yield* seedPerson("phownlise", nothing, NOW);
          const key = yield* fileKeyOf(ola);
          const leader = yield* leaderOf(lise, ola);

          // Control of the refusal above: the same leader call, before the person has consented, is refused.
          assert.isTrue(
            failedWith(
              yield* Effect.exit(
                setPhoto(leader, ola.personId, { photo: key })
              ),
              Conflict
            )
          );

          yield* setPhoto(selfPrincipal(ola.personId), ola.personId, {
            consent: true,
            photo: key,
          });

          assert.strictEqual(yield* photoOf(ola), key);

          assert.deepStrictEqual(yield* photoConsentOf(ola), [
            { text_version: 1, withdrawn: false },
          ]);

          // The audit row says who gave the consent: the person, and nobody else did.
          assert.strictEqual(
            yield* countWhere(
              "audit_log",
              `action = 'consent.given' and entity_key = '${ola.personId}:photo' and person_id = ${ola.personId}`
            ),
            1
          );

          // With the consent current, the same leader call that was refused is allowed, and writes no second consent.
          const other = yield* withFile("phother");
          const otherKey = yield* fileKeyOf(other);

          yield* setPhoto(leader, ola.personId, { photo: otherKey });

          assert.strictEqual(yield* photoOf(ola), otherKey);

          assert.deepStrictEqual(yield* photoConsentOf(ola), [
            { text_version: 1, withdrawn: false },
          ]);

          assert.strictEqual(
            yield* countWhere(
              "audit_log",
              `action = 'consent.given' and entity_key = '${ola.personId}:photo'`
            ),
            1
          );
        })
    );

    it.effect(
      "removing the photo withdraws the consent: the next photo, by a leader, needs a new one",
      () =>
        Effect.gen(function* removal() {
          const ola = yield* withFile("phrem");
          const lise = yield* seedPerson("phremlise", nothing, NOW);
          const key = yield* fileKeyOf(ola);
          const leader = yield* leaderOf(lise, ola);

          yield* setPhoto(selfPrincipal(ola.personId), ola.personId, {
            consent: true,
            photo: key,
          });

          // A leader removes it on the person's request: the photo goes, and its file with it (nobody else shows it).
          yield* setPhoto(leader, ola.personId, { photo: null });

          assert.isNull(yield* photoOf(ola));

          assert.strictEqual(
            yield* countWhere(
              "public_file",
              `key = '${key}' and deleted_at is not null`
            ),
            1
          );

          assert.deepStrictEqual(yield* photoConsentOf(ola), [
            { text_version: 1, withdrawn: true },
          ]);

          // A new file for the same person: the consent that a photo needs is gone, so the leader's call is refused.
          const next = yield* withFile("phremnext");
          const nextKey = yield* fileKeyOf(next);
          const before = yield* snapshot;

          const exit = yield* Effect.exit(
            setPhoto(leader, ola.personId, { photo: nextKey })
          );

          assert.isTrue(failedWith(exit, Conflict), describeExit(exit));
          assert.deepStrictEqual(yield* snapshot, before);
        })
    );

    it.effect(
      "a photo that is not a registered file is refused as a validation failure, even with the person's consent, and nothing changes",
      () =>
        Effect.gen(function* missingFile() {
          const ola = yield* seedPerson("phmissing", nothing, NOW);
          const before = yield* snapshot;

          const exit = yield* Effect.exit(
            setPhoto(selfPrincipal(ola.personId), ola.personId, {
              consent: true,
              photo: `${"0".repeat(64)}.png`,
            })
          );

          assert.isTrue(failedWith(exit, ValidationFailed), describeExit(exit));
          assert.deepStrictEqual(yield* snapshot, before);
        })
    );
  }
);
