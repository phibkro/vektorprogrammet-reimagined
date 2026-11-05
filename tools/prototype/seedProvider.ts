import { createClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";
import {
  Array as Arr,
  Console,
  Effect,
  Option,
  Redacted,
  Schema,
} from "effect";

import { withClient } from "../../apps/web/test/db/support/disposableDatabase.ts";
import {
  LOCAL_FAKE_PASSWORD,
  LOCAL_PEOPLE,
} from "../../apps/web/test/fixtures/localPeople.ts";

// EX-0032: Schema.TaggedError is a native class factory, not a throw site.
class SetupFailure extends Schema.TaggedError<
  SetupFailure,
  { readonly brand: unique symbol }
>()("SetupFailure", {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
}) {}

// Supabase's admin SDK is the foreign Promise boundary. It cannot be cancelled by Effect.
const call = <A>(
  operation: () => PromiseLike<{
    data: A | null;
    error: { message: string } | null;
  }>
) =>
  Effect.tryPromise({
    catch: (cause) =>
      new SetupFailure({ cause, message: "Supabase request failed" }),
    try: () => Promise.resolve(operation()),
  }).pipe(
    Effect.flatMap(({ data, error }) =>
      error || data === null
        ? Effect.fail(
            new SetupFailure({
              message: error
                ? `Supabase request failed: ${error.message}`
                : "Supabase returned no data",
            })
          )
        : Effect.succeed(data)
    )
  );

const peopleSchema = Schema.Array(
  Schema.Struct({
    email: Schema.String,
    id: Schema.Finite,
    name: Schema.String,
  })
);

const required = [
  "ada.admin@example.org",
  "lise.leder@example.org",
  "nora.nybegynner@example.org",
] as const;

const tagline = {
  content: [
    {
      _key: "intro",
      _type: "block",
      children: [
        {
          _key: "intro-span",
          _type: "span",
          marks: [],
          text: "Velkommen til Vektorprogrammet",
        },
      ],
      markDefs: [],
      style: "normal",
    },
  ],
  title: "Velkommen",
};

export const seedProvider = Effect.fnUntraced(function* seedProvider(
  url: string,
  secret: Redacted.Redacted,
  publishable: Redacted.Redacted,
  database: Redacted.Redacted
) {
  const encodedTagline = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Unknown)
  )(tagline);

  const people = yield* withClient(database, (sql) =>
    Effect.gen(function* readPeople() {
      const rows =
        yield* sql`select person.id, person.name, person.email from person join account on account.person_id = person.id where account.state = 'Active' and person.name in (${LOCAL_PEOPLE[0]}, ${LOCAL_PEOPLE[1]}, ${LOCAL_PEOPLE[2]}, ${LOCAL_PEOPLE[3]}, ${LOCAL_PEOPLE[4]}, ${LOCAL_PEOPLE[5]})`;

      const decoded = yield* Schema.decodeUnknownEffect(peopleSchema)(rows);

      if (
        Arr.some(
          required,
          (email) => !Arr.some(decoded, (person) => person.email === email)
        ) ||
        Arr.some(
          decoded,
          (person) =>
            person.email !==
            `${person.name.toLowerCase().replaceAll(" ", ".")}@example.org`
        )
      ) {
        return yield* new SetupFailure({
          message: "Synthetic domain people are missing or ambiguous",
        });
      }

      yield* sql`insert into site_content (collection, slug, draft, published, published_at)
      values ('texts', 'home-tagline', ${encodedTagline}::jsonb, ${encodedTagline}::jsonb, now()) on conflict (collection, slug) do nothing`;

      return decoded;
    })
  );

  const admin = createClient(url, Redacted.value(secret), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  yield* Effect.gen(function* provisionProvider() {
    const existing = [];

    for (let page = 1; ; page += 1) {
      const result = yield* call<{ users: User[] }>(() =>
        admin.auth.admin.listUsers({ page, perPage: 100 })
      );

      existing.push(...result.users);

      if (result.users.length < 100) {
        break;
      }
    }

    for (const person of people) {
      const found = Arr.findFirst(
        existing,
        (user) => user.email === person.email
      );

      if (Option.isSome(found)) {
        if (found.value.app_metadata.personId !== person.id) {
          return yield* new SetupFailure({
            message: "Existing synthetic email is linked to a different person",
          });
        }
      } else {
        yield* call<{ user: User | null }>(() =>
          admin.auth.admin.createUser({
            app_metadata: { personId: person.id },
            email: person.email,
            email_confirm: true,
            password: LOCAL_FAKE_PASSWORD,
          })
        );
      }
    }

    return yield* Effect.void;
  });

  yield* Effect.gen(function* provisionBuckets() {
    const buckets = yield* call(() => admin.storage.listBuckets());

    for (const name of ["public-files", "receipts"]) {
      const bucket = Arr.findFirst(buckets, (item) => item.name === name);

      if (Option.isSome(bucket) && bucket.value.public) {
        return yield* new SetupFailure({
          message: `Bucket ${name} must be private`,
        });
      }

      if (Option.isNone(bucket)) {
        yield* call(() => admin.storage.createBucket(name, { public: false }));
      }
    }

    return yield* Effect.void;
  });

  const client = createClient(url, Redacted.value(publishable), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const login = yield* call<{ user: User | null }>(() =>
    client.auth.signInWithPassword({
      email: "ada.admin@example.org",
      password: LOCAL_FAKE_PASSWORD,
    })
  );

  const ada = Arr.findFirst(
    people,
    (person) => person.email === "ada.admin@example.org"
  );

  if (
    Option.isNone(ada) ||
    login.user?.app_metadata.personId !== ada.value.id
  ) {
    return yield* new SetupFailure({
      message: "Synthetic sign-in did not resolve to its person",
    });
  }

  return yield* Console.log(
    "Supabase Auth sign-in and private bucket setup succeeded (synthetic data)."
  );
});
