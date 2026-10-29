/**
 * A person with data in every table that the catalog names (spec 0007b), each value distinctive, so that a test can ask
 * whether any value of one person turned up where it should not. `Holdings` says which tables get rows; everything is
 * written with SQL, outside a command, because the values and the instants are the point.
 */
import { EmailAddress, OutboxMessage } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Schema,
  String as Str,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";

import { activateAccount } from "./accountsWorld.ts";
import { encodeJson } from "./json.ts";
import { asPerson, world } from "./teamsWorld.ts";

/** Which tables a seeded person has rows in. */
export const Holdings = Schema.Struct({
  account: Schema.Boolean,
  alumniRequest: Schema.Boolean,
  code: Schema.Boolean,
  digest: Schema.Boolean,
  file: Schema.Boolean,
  grant: Schema.Boolean,
  keepDetails: Schema.Boolean,
  mail: Schema.Boolean,
  memberships: Schema.Literals([0, 1, 2]),
  news: Schema.Boolean,
  photo: Schema.Boolean,
});

export type Holding = typeof Holdings.Type;

/** Everything: a row in every table that a person can have rows in. */
export const everything: Holding = {
  account: true,
  alumniRequest: true,
  code: true,
  digest: true,
  file: true,
  grant: true,
  keepDetails: true,
  mail: true,
  memberships: 2,
  news: true,
  photo: true,
};

/** Nothing: a person with no rows but their own. */
export const nothing: Holding = {
  account: false,
  alumniRequest: false,
  code: false,
  digest: false,
  file: false,
  grant: false,
  keepDetails: false,
  mail: false,
  memberships: 0,
  news: false,
  photo: false,
};

/** A seeded person: the ids, the values that belong to them alone, and the secrets that no export may hold. */
export interface Seeded {
  readonly email: string;
  readonly holdings: Holding;
  readonly name: string;
  readonly personId: number;
  readonly positionId: number;
  /** The credential values (a password hash, a session token, a code hash): none may appear in their own export either. */
  readonly secrets: readonly string[];
  readonly tag: string;
  readonly teamId: number;
  /** The personal values (names and addresses): none may appear in anyone else's export or after an erasure. */
  readonly values: readonly string[];
}

const at = (instant: string): Date =>
  DateTime.toDateUtc(DateTime.makeUnsafe(instant));

/** 64 hex characters that differ per tag: the form of a code hash and of a file key's hash. */
const hexOf = (text: string): string => {
  const hex = Arr.join(
    Arr.map(Arr.fromIterable(text), (character) =>
      Option.getOrElse(Str.codePointAt(character, 0), () => 0).toString(16)
    ),
    ""
  );

  return Str.slice(0, 64)(Str.padEnd(64, "0")(hex));
};

/** Writes a person with these holdings. `now` is when the rows say they were made. */
export const seedPerson = Effect.fnUntraced(function* seedPerson(
  tag: string,
  holdings: Holding,
  now: DateTime.Utc
) {
  const sql = yield* SqlClient;
  const arranged = yield* world(tag);
  const { person, memberPosition, team } = arranged;
  const personId: number = person.id;
  const instant = DateTime.toDateUtc(now);

  const companyEmail = `${tag}.firma@example.org`;
  const authEmail = `${tag}.auth@example.org`;
  const authName = `Auth ${tag}`;
  const password = `secret-password-${tag}`;
  const token = `secret-token-${tag}`;
  const codeHash = hexOf(`code-${tag}`);

  yield* sql`update person set company_email = ${companyEmail} where id = ${personId}`;

  // `Arr.range(1, 0)` and `Arr.makeBy(0, …)` both make one element: a count that may be zero is a filter.
  for (const index of Arr.filter([1, 2], (n) => n <= holdings.memberships)) {
    yield* sql`insert into membership (end_term, end_year, person_id, position_id, start_term, start_year, team_id)
      values ('HOST', ${2020 + index}, ${personId}, ${memberPosition}, 'HOST', ${2020 + index}, ${team.id})`;
  }

  if (holdings.account) {
    yield* asPerson(person.id, activateAccount);

    yield* sql`insert into auth_user (id, created_at, email, name, person_id, updated_at)
      values (${`user-${tag}`}, ${instant}, ${authEmail}, ${authName}, ${personId}, ${instant})`;

    yield* sql`insert into auth_account (id, account_id, created_at, password, provider_id, updated_at, user_id)
      values (${`account-${tag}`}, ${tag}, ${instant}, ${password}, 'credential', ${instant}, ${`user-${tag}`})`;

    yield* sql`insert into auth_session (id, created_at, expires_at, token, updated_at, user_id)
      values (${`session-${tag}`}, ${instant}, ${at("2099-01-01T00:00:00Z")}, ${token}, ${instant}, ${`user-${tag}`})`;
  }

  if (holdings.code) {
    yield* sql`insert into code (expires_at, hash, purpose, subject)
      values (${at("2099-01-01T00:00:00Z")}, ${codeHash}, 'resetPassword', ${personId})`;
  }

  for (const [kind, given] of [
    ["keepDetails", holdings.keepDetails],
    ["news", holdings.news],
    ["photo", holdings.photo],
  ] as const) {
    if (given) {
      yield* sql`insert into consent (given_at, kind, person_id, text_version)
        values (${instant}, ${kind}, ${personId}, 1)`;
    }
  }

  if (holdings.digest) {
    yield* sql`insert into ending_soon_digest (person_id, recorded_at, term, year)
      values (${personId}, ${instant}, 'HOST', 2025)`;
  }

  if (holdings.alumniRequest) {
    yield* sql`insert into alumni_request (engagement_end, person_id, requested_at)
      values (${instant}, ${personId}, ${instant})`;
  }

  if (holdings.grant) {
    yield* sql`insert into admin_grant (person_id, until) values (${personId}, ${at("2099-01-01T00:00:00Z")})`;
  }

  if (holdings.file) {
    const key = `${hexOf(`file-${tag}`)}.png`;

    yield* sql`insert into public_file (content_type, key, name, sha256, size, uploaded_at, uploaded_by)
      values ('image/png', ${key}, ${`${tag}.png`}, ${hexOf(`file-${tag}`)}, 10, ${instant}, ${personId})`;
  }

  if (holdings.mail) {
    const payload = yield* encodeJson(
      OutboxMessage.cases.Email.make({
        replyTo: null,
        subject: `Emne ${tag}`,
        text: `Hei ${person.name}`,
        to: EmailAddress.make(person.email),
      })
    );

    yield* sql`insert into outbox (created_at, kind, next_attempt_at, payload)
      values (${instant}, 'Email', ${instant}, ${payload}::jsonb)`;

    yield* sql`insert into captured_mail (recipient, sent_at, subject, text)
      values (${person.email}, ${instant}, ${`Emne ${tag}`}, ${`Hei ${person.name}`})`;
  }

  const seeded: Seeded = {
    email: person.email,
    holdings,
    name: person.name,
    personId,
    positionId: memberPosition,
    secrets: [
      ...(holdings.account ? [password, token] : []),
      ...(holdings.code ? [codeHash] : []),
    ],
    tag,
    teamId: team.id,
    values: [
      person.name,
      person.email,
      companyEmail,
      ...(holdings.account ? [authEmail, authName] : []),
    ],
  };

  return seeded;
});
