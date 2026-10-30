/**
 * Spec 0009 F6 (RULE-306): an application is never joined to a known verified person by a submit. A submit makes a new
 * unverified person; the link in the mail verifies the address, and when another person already holds the address
 * verified, the new person is merged into that one: the application belongs to the verified person, the later
 * duplicate of one period is dropped (the earlier stands), and the duplicate is a tombstone without a name or an address.
 * A code that is wrong, expired, not yet acknowledged or already spent verifies nothing.
 */
import { assert, layer } from "@effect/vitest";
import {
  AdmissionEndpoints,
  EmailAddress,
  Forbidden,
  PersonId,
  PersonRepository,
  PersonalDataEndpoints,
  anonymous,
  mintCode,
} from "@vektorprogrammet/domain";
import { Array as Arr, DateTime, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { transactional } from "../src/index.ts";
import {
  applicationInput,
  arrange,
  leaderOf,
  periodInput,
  schedule,
} from "./support/admissionWorld.ts";
import { issueUnsent, issueUsable } from "./support/codes.ts";
import { postgresDatabase } from "./support/database.ts";
import { assertFailedWith } from "./support/failures.ts";
import { runAs } from "./support/personalDataActors.ts";
import { at } from "./support/retentionRun.ts";
import { asPerson } from "./support/teamsWorld.ts";

const BEFORE = DateTime.makeUnsafe("2027-01-10T08:00:00Z");
const DURING = DateTime.makeUnsafe("2027-03-01T08:00:00Z");
const LATER = DateTime.makeUnsafe("2027-03-02T08:00:00Z");
const FAR = DateTime.makeUnsafe("2099-01-01T00:00:00Z");

type Arranged = Effect.Success<ReturnType<typeof arrange>>;

/** A department with a period that is open on `DURING`. */
const openDepartment = Effect.fnUntraced(function* openDepartment(tag: string) {
  const fixture: Arranged = yield* arrange(tag);
  yield* at(BEFORE);

  yield* schedule(
    leaderOf(fixture.department.id, fixture.person.id),
    periodInput(fixture.department.id)
  );

  yield* at(DURING);

  return fixture;
});

const submit = (input: ReturnType<typeof applicationInput>) =>
  runAs(anonymous, AdmissionEndpoints.submitApplication(input));

/** The person that an application belongs to. */
const ownerOf = Effect.fnUntraced(function* ownerOf(applicationId: number) {
  const sql = yield* SqlClient;

  const [row] = yield* sql<{
    person_id: number;
  }>`select person_id from application where id = ${applicationId}`;

  return row?.person_id ?? 0;
});

/** A code for `personId`'s purpose `verifyApplication`, stored as `how` leaves it; the token is what the mail would carry. */
const codeFor = Effect.fnUntraced(function* codeFor(
  personId: number,
  how: "usable" | "unsent",
  expiresAt: DateTime.Utc = FAR
) {
  const { hash, token } = yield* mintCode();

  yield* asPerson(PersonId.make(personId), (locked) =>
    (how === "usable" ? issueUsable : issueUnsent)(locked, {
      expiresAt,
      hash,
      purpose: "verifyApplication",
    })
  );

  return token;
});

const verify = (token: string) =>
  transactional(PersonalDataEndpoints.verifyApplicantEmail({ code: token }));

/** What a test asks of a person: whether the address is verified, who the record was merged into, and the name. */
const personOf = Effect.fnUntraced(function* personOf(id: number) {
  const sql = yield* SqlClient;

  const [row] = yield* sql<{
    readonly email: string | null;
    readonly email_verified: boolean;
    readonly field_of_study_id: number | null;
    readonly merged_into: number | null;
    readonly name: string | null;
  }>`select email, email_verified, field_of_study_id, merged_into, name from person where id = ${id}`;

  assert.isDefined(row);

  return row;
});

const applicationsOf = Effect.fnUntraced(function* applicationsOf(
  personId: number
) {
  const sql = yield* SqlClient;

  const rows = yield* sql<{
    id: number;
  }>`select id from application where person_id = ${personId} order by id`;

  return Arr.map(rows, (row) => row.id);
});

/**
 * Two submits of one address in one period, an hour apart, then both links used, the later submission's first when
 * `laterLinkFirst`: whichever link is used first, the earlier application is the one left, on the person that the
 * first link verified, and the other person is its tombstone.
 */
const twoApplications = Effect.fnUntraced(function* twoApplications(
  tag: string,
  laterLinkFirst: boolean
) {
  const fixture = yield* openDepartment(tag);
  const email = `dobbel.${tag}@example.org`;

  const submitOne = () =>
    submit(
      applicationInput(fixture.department.id, fixture.fieldOfStudy.id, email)
    );

  const earlier = yield* submitOne();
  yield* at(DateTime.add(DURING, { hours: 1 }));
  const later = yield* submitOne();
  const ofEarlier = yield* ownerOf(earlier.applicationId);
  const ofLater = yield* ownerOf(later.applicationId);
  assert.notStrictEqual(ofEarlier, ofLater);

  const [firstLink, secondLink] = laterLinkFirst
    ? [ofLater, ofEarlier]
    : [ofEarlier, ofLater];

  yield* verify(yield* codeFor(firstLink, "usable"));
  yield* verify(yield* codeFor(secondLink, "usable"));

  assert.deepStrictEqual(yield* applicationsOf(firstLink), [
    earlier.applicationId,
  ]);
  assert.deepStrictEqual(yield* applicationsOf(secondLink), []);
  assert.strictEqual((yield* personOf(secondLink)).merged_into, firstLink);
});

layer(postgresDatabase({ maxConnections: 20 }), {
  excludeTestServices: true,
})(
  "spec 0009 F6 (RULE-306): the address is verified by a link, and a known verified address is joined only then",
  (outer) => {
    outer.layer(TestClock.layer())((it) => {
      it.effect(
        "a submit with the address of a verified person leaves that person untouched; the link joins the application to them, and the duplicate is a tombstone",
        () =>
          Effect.gen(function* collision() {
            const sql = yield* SqlClient;
            const fixture = yield* openDepartment("id1");
            const email = "kjent.id1@example.org";

            // The verified person: the address is theirs.
            const known = yield* transactional(
              PersonRepository.use((people) =>
                people.create({
                  email: EmailAddress.make(email),
                  fieldOfStudyId: fixture.fieldOfStudy.id,
                  name: "Kjent Person",
                })
              )
            );

            yield* sql`update person set email_verified = true where id = ${known.id}`;
            const knownBefore = yield* personOf(known.id);

            const receipt = yield* submit(
              applicationInput(
                fixture.department.id,
                fixture.fieldOfStudy.id,
                email
              )
            );

            const duplicate = yield* ownerOf(receipt.applicationId);

            // The negative control: with no verification the verified person has no new application and no changed field.
            assert.notStrictEqual(duplicate, known.id);
            assert.deepStrictEqual(yield* applicationsOf(known.id), []);
            assert.deepStrictEqual(yield* personOf(known.id), knownBefore);
            assert.strictEqual(
              (yield* personOf(duplicate)).email_verified,
              false
            );

            const token = yield* codeFor(duplicate, "usable");
            yield* verify(token);

            assert.deepStrictEqual(yield* applicationsOf(known.id), [
              receipt.applicationId,
            ]);
            assert.deepStrictEqual(yield* applicationsOf(duplicate), []);

            const tombstone = yield* personOf(duplicate);
            assert.strictEqual(tombstone.merged_into, known.id);
            assert.isFalse(tombstone.email === email);
            assert.isFalse(tombstone.name?.includes("Søker") ?? false);
            // What the applicant chose on the form is not kept on the tombstone (review round 1); the survivor keeps its own.
            assert.isNull(tombstone.field_of_study_id);

            const survivor = yield* personOf(known.id);
            assert.strictEqual(survivor.name, knownBefore.name);
            assert.isTrue(survivor.email_verified);

            // The code was spent by the same transaction: it cannot be used again, and nothing more changes.
            assertFailedWith(
              yield* Effect.exit(verify(token)),
              Forbidden,
              "the spent code"
            );

            const audit = yield* sql<{
              action: string;
            }>`select action from audit_log where entity = 'Person' and entity_key in (${String(known.id)}, ${String(duplicate)}) and action in ('applicant.verified', 'person.merged') order by id`;

            assert.deepStrictEqual(
              Arr.map(audit, (row) => row.action),
              ["person.merged", "applicant.verified"]
            );
          })
      );

      it.effect(
        "a submit with a new address is verified by the link and keeps its application",
        () =>
          Effect.gen(function* newAddress() {
            const fixture = yield* openDepartment("id2");

            const receipt = yield* submit(
              applicationInput(
                fixture.department.id,
                fixture.fieldOfStudy.id,
                "ny.id2@example.org"
              )
            );

            const owner = yield* ownerOf(receipt.applicationId);
            assert.isFalse((yield* personOf(owner)).email_verified);

            yield* verify(yield* codeFor(owner, "usable"));

            const after = yield* personOf(owner);
            assert.isTrue(after.email_verified);
            assert.isNull(after.merged_into);
            assert.deepStrictEqual(yield* applicationsOf(owner), [
              receipt.applicationId,
            ]);
          })
      );

      it.effect(
        "a code that is wrong, spent, expired or not yet acknowledged verifies nothing",
        () =>
          Effect.gen(function* unusable() {
            const fixture = yield* openDepartment("id3");

            const receipt = yield* submit(
              applicationInput(
                fixture.department.id,
                fixture.fieldOfStudy.id,
                "kode.id3@example.org"
              )
            );

            const owner = yield* ownerOf(receipt.applicationId);
            const before = yield* personOf(owner);

            assertFailedWith(
              yield* Effect.exit(verify(`c_${"x".repeat(43)}`)),
              Forbidden,
              "a code that was never issued"
            );

            const unsent = yield* codeFor(owner, "unsent");
            assertFailedWith(
              yield* Effect.exit(verify(unsent)),
              Forbidden,
              "a code whose mail has not been acknowledged"
            );

            const expired = yield* codeFor(
              owner,
              "usable",
              DateTime.add(DURING, { hours: 1 })
            );

            yield* at(LATER);
            assertFailedWith(
              yield* Effect.exit(verify(expired)),
              Forbidden,
              "an expired code"
            );

            assert.deepStrictEqual(yield* personOf(owner), before);

            // A code for another purpose is no key to this command either.
            const { hash, token } = yield* mintCode();

            yield* asPerson(PersonId.make(owner), (locked) =>
              issueUsable(locked, {
                expiresAt: FAR,
                hash,
                purpose: "resetPassword",
              })
            );

            assertFailedWith(
              yield* Effect.exit(verify(token)),
              Forbidden,
              "a code of another purpose"
            );
            assert.deepStrictEqual(yield* personOf(owner), before);
          })
      );

      it.effect(
        "the same address submitted twice in one period, the earlier link used first: the later application is dropped and the earlier stands",
        () => twoApplications("id4", false)
      );

      it.effect(
        "review round 1: the later link used first changes nothing: the earlier application still stands",
        () => twoApplications("id5", true)
      );
    });
  }
);
