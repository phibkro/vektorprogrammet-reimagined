import { inspect } from "node:util";

/** Spec 0007 falsifiers 2 and 5: the installed Better Auth adapter against real PostgreSQL. */
import { PgClient } from "@effect/sql-pg";
import { assert, layer } from "@effect/vitest";
import { DatabaseLive } from "@vektorprogrammet/db";
import {
  TestDatabaseUrl,
  migratedTestDatabase,
  withClient,
} from "@vektorprogrammet/db/testing";
import {
  AUTH_TABLES,
  AuthTablesDatabaseUrl,
  authTablesRole,
} from "@vektorprogrammet/db/testing/auth-tables-role";
import {
  ReadOnlyDatabaseUrl,
  assertPermissionDenied,
  readOnlyRole,
} from "@vektorprogrammet/db/testing/read-only-role";
import type {
  AccountRepository,
  SignInDirectory,
} from "@vektorprogrammet/domain";
import {
  AccountEndpoints,
  AggregateLocks,
  CodeRepository,
  CurrentPrincipal,
  Forbidden,
  PasswordHash,
  PersonId,
  PrincipalDirectory,
  SessionDirectory,
  anonymous,
  mintCode,
} from "@vektorprogrammet/domain";
import {
  Array as Arr,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Pool } from "pg";

import { sessionClient } from "../src/lib/sessionClient";
import {
  Auth,
  authLayer,
  makeAuth,
  wrongPasswordResponse,
} from "../src/server/auth";
import { isAuthSecret } from "../src/server/authStartup";
import { hashPassword, passwordHasherLayer } from "../src/server/password";
import { resolvePrincipal } from "../src/server/principal";
import { webCryptoLayer } from "../src/server/webCrypto";
import { bcryptFixtures, fixturePassword } from "./support/passwordFixtures";
import { transacted } from "./support/transacted";

const origin = "https://auth.example";
const secret = "local-fake-signing-secret-only-123456789";

const live = Layer.unwrap(
  Effect.gen(function* live() {
    const url = yield* TestDatabaseUrl;
    const authUrl = yield* AuthTablesDatabaseUrl;
    const database = DatabaseLive({ maxConnections: 8, url });

    // Better Auth's pool is the role that holds privileges on its four tables only (spec 0017, falsifier 6), and the
    // application's own database layer, built once, answers what the library asks of the domain.
    return Layer.mergeAll(
      database,
      authLayer({
        BETTER_AUTH_SECRET: secret,
        HYPERDRIVE: { connectionString: Redacted.value(authUrl) },
        SITE_URL: origin,
      }).pipe(Layer.provide(database)),
      passwordHasherLayer,
      webCryptoLayer
    );
  })
).pipe(
  Layer.provideMerge(authTablesRole),
  Layer.provideMerge(migratedTestDatabase),
  Layer.orDie
);

const seed = Effect.gen(function* seedAuthPeople() {
  const sql = yield* SqlClient;
  yield* sql`insert into department (id, city, email, name, short_name) values (101, 'Authby', 'auth@example.org', 'Auth', 'AUT')`;
  yield* sql`insert into field_of_study (id, department_id, name, short_name) values (101, 101, 'Auth', 'AUT')`;

  for (const [id, state] of [
    [101, "Invited"],
    [102, "Active"],
    [103, "Deactivated"],
  ] as const) {
    const email = `${state.toLowerCase()}@example.org`;
    const user = `auth-${id}`;
    yield* sql`insert into person (id, name, email, email_verified, field_of_study_id) values (${id}, ${state}, ${email}, true, 101)`;
    yield* sql`insert into account (person_id, state) values (${id}, ${state})`;
    yield* sql`insert into auth_user (id, person_id, email, email_verified, name, created_at, updated_at) values (${user}, ${id}, ${email}, true, ${state}, now(), now())`;
    yield* sql`insert into auth_account (id, account_id, provider_id, user_id, password, created_at, updated_at) values (${`credential-${id}`}, ${user}, 'credential', ${user}, ${bcryptFixtures[0]}, now(), now())`;
  }
});

const seeded = Layer.effectDiscard(seed).pipe(Layer.provideMerge(live));

const signInRequest = (
  email: string,
  password: string,
  userAgent = "first-client",
  signal?: AbortSignal
) =>
  new Request(`${origin}/api/auth/sign-in/email`, {
    body: JSON.stringify({ email, password, rememberMe: true }),
    headers: {
      "content-type": "application/json",
      origin,
      "user-agent": userAgent,
    },
    method: "POST",
    signal,
  });

const signIn = (email: string, password: string, userAgent = "first-client") =>
  Auth.use((auth) => auth.handle(signInRequest(email, password, userAgent)));

/** The external caller, not the Effect under test, owns this abort signal. */
const startAbortable = <E>(
  handle: (request: Request) => Effect.Effect<Response, E>
) => {
  const controller = new AbortController();

  const request = signInRequest(
    "active@example.org",
    fixturePassword,
    "aborted-client",
    controller.signal
  );

  return {
    controller,
    fiber: Effect.runFork(handle(request), { signal: controller.signal }),
  };
};

const cookieOf = (response: Response): string => {
  const token = Arr.findFirst(response.headers.getSetCookie(), (value) =>
    value.includes("session_token=")
  );

  assert.isTrue(
    Option.isSome(token),
    "successful sign-in returns a session cookie"
  );

  return Option.getOrElse(token, () => "").split(";")[0] ?? "";
};

const text = (response: Response) => Effect.promise(() => response.text());

const Session = Schema.Struct({ id: Schema.String, token: Schema.String });

type AuthBody =
  | { readonly token: string }
  | { readonly currentPassword: string; readonly newPassword: string };

const callAuth = (path: string, cookie: string, body?: AuthBody) =>
  Auth.use((auth) =>
    auth.handle(
      new Request(`${origin}/api/auth/${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "content-type": "application/json", cookie, origin },
        method: body === undefined ? "GET" : "POST",
      })
    )
  );

const currentSession = (cookie: string) =>
  Auth.use((auth) => auth.session(new Headers({ cookie })));

/** The command that a `Forbidden` failure names, when the exit failed with one. */
const refusedCommand = (exit: Exit.Exit<unknown, unknown>) =>
  Option.filter(Exit.findErrorOption(exit), Schema.is(Forbidden)).pipe(
    Option.map((refusal) => refusal.command)
  );

const mutantAuth = (url: Redacted.Redacted) =>
  Effect.gen(function* buildMutant() {
    const run = yield* FiberSet.makeRuntimePromise<
      AccountRepository | SignInDirectory
    >();

    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: Redacted.value(url) })),
      (owned) => Effect.promise(() => owned.end())
    );

    return makeAuth(pool, secret, origin, run);
  });

layer(readOnlyRole.pipe(Layer.provideMerge(seeded)), {
  excludeTestServices: true,
})("spec 0007: Better Auth on PostgreSQL", (it) => {
  it.effect(
    "all login paths admit Active only and refusals match a wrong password byte for byte",
    () =>
      Effect.gen(function* guardProperty() {
        const wrong = yield* signIn("active@example.org", "not the password");
        const wrongBody = yield* text(wrong);
        assert.strictEqual(wrong.status, 401);
        assert.strictEqual(yield* text(wrongPasswordResponse()), wrongBody);

        for (const state of ["invited", "deactivated"] as const) {
          const refused = yield* signIn(
            `${state}@example.org`,
            fixturePassword
          );

          assert.strictEqual(refused.status, wrong.status);
          assert.strictEqual(yield* text(refused), wrongBody);
        }

        const accepted = yield* signIn("active@example.org", fixturePassword);
        assert.strictEqual(accepted.status, 200);
        const headers = new Headers({ cookie: cookieOf(accepted) });

        const principal = yield* resolvePrincipal(
          "production",
          undefined,
          headers
        );

        assert.isTrue(Predicate.isTagged(principal, "Person"));

        if (Predicate.isTagged(principal, "Person")) {
          assert.strictEqual(principal.personId, PersonId.make(102));
        }

        const sql = yield* SqlClient;

        const hashes =
          yield* sql`select password from auth_account where user_id = 'auth-102' and provider_id = 'credential'`;

        const saved = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ password: Schema.String })
        )(hashes[0]).pipe(Effect.orDie);

        assert.strictEqual(
          saved.password,
          bcryptFixtures[0],
          "legacy sign-in must not rehash the credential"
        );

        yield* sql`update account set state = 'Deactivated' where person_id = 102`;
        assert.isTrue(
          Predicate.isTagged(
            yield* resolvePrincipal("production", undefined, headers),
            "Anonymous"
          )
        );
        const directory = yield* PrincipalDirectory;

        const withoutAccountGuard = PrincipalDirectory.of({
          ...directory,
          activeById: (_personId, at) => directory.byName("Active", at),
        });

        const bypassed = yield* resolvePrincipal(
          "production",
          undefined,
          headers
        ).pipe(Effect.provideService(PrincipalDirectory, withoutAccountGuard));

        assert.isTrue(
          Predicate.isTagged(bypassed, "Person"),
          "negative control without the Account check admits the deactivated session"
        );
        const after = yield* signIn("active@example.org", fixturePassword);
        assert.strictEqual(after.status, wrong.status);
        assert.strictEqual(yield* text(after), wrongBody);
      })
  );

  it.effect(
    "two clients list derived activity, revoke one without domain writes, and password change ends other sessions",
    () =>
      Effect.gen(function* sessionJourney() {
        const sql = yield* SqlClient;
        yield* sql`update account set state = 'Active' where person_id = 102`;
        yield* sql`delete from auth_session where user_id = 'auth-102'`;

        const first = yield* signIn(
          "active@example.org",
          fixturePassword,
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
        );

        const second = yield* signIn(
          "active@example.org",
          fixturePassword,
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"
        );

        assert.strictEqual(first.status, 200);
        assert.strictEqual(second.status, 200);
        const firstCookie = cookieOf(first);
        const secondCookie = cookieOf(second);
        const secondSession = yield* currentSession(secondCookie);
        assert.isNotNull(secondSession.value);
        const secondId = secondSession.value?.session.id ?? "";
        yield* sql`update auth_session set created_at = now() - interval '2 days' where user_id = 'auth-102'`;
        yield* sql`insert into audit_log (action, at, client, entity, entity_key, person_id, session_id) values ('person.profileUpdated', now() - interval '1 day', 'browser', 'Person', '102', 102, ${secondId})`;

        const sessions = yield* (yield* SessionDirectory).byPerson(
          PersonId.make(102),
          yield* DateTime.now
        );

        assert.strictEqual(sessions.length, 2);

        const activity = Arr.findFirst(
          sessions,
          (session) => session.id === secondId
        );

        assert.isTrue(Option.isSome(activity));

        if (Option.isSome(activity)) {
          assert.isAbove(
            DateTime.toEpochMillis(activity.value.lastSeen),
            DateTime.toEpochMillis(activity.value.createdAt)
          );
          assert.strictEqual(
            sessionClient(activity.value.userAgent).device,
            "phone"
          );
        }

        const listed = yield* callAuth("list-sessions", firstCookie);
        assert.strictEqual(listed.status, 200);
        const json: unknown = yield* Effect.promise(() => listed.json());

        const authSessions = yield* Schema.decodeUnknownEffect(
          Schema.Array(Session)
        )(json).pipe(Effect.orDie);

        const other = Arr.findFirst(
          authSessions,
          (session) => session.id === secondId
        );

        assert.isTrue(Option.isSome(other));
        const token = Option.isSome(other) ? other.value.token : "";

        const before =
          yield* sql`select to_jsonb(p) as person, to_jsonb(a) as account from person p join account a on a.person_id = p.id where p.id = 102`;

        const auditBefore =
          yield* sql`select to_jsonb(a) as audit from audit_log a where person_id = 102 order by id`;

        const revoked = yield* callAuth("revoke-session", firstCookie, {
          token,
        });

        assert.strictEqual(revoked.status, 200);
        assert.isNull((yield* currentSession(secondCookie)).value);
        assert.isNotNull((yield* currentSession(firstCookie)).value);
        assert.deepStrictEqual(
          yield* sql`select to_jsonb(p) as person, to_jsonb(a) as account from person p join account a on a.person_id = p.id where p.id = 102`,
          before
        );
        assert.deepStrictEqual(
          yield* sql`select to_jsonb(a) as audit from audit_log a where person_id = 102 order by id`,
          auditBefore
        );

        const third = yield* signIn(
          "active@example.org",
          fixturePassword,
          "another-client"
        );

        assert.strictEqual(third.status, 200);
        const thirdCookie = cookieOf(third);

        const changed = yield* callAuth("change-password", firstCookie, {
          currentPassword: fixturePassword,
          newPassword: "new password 123",
        });

        assert.strictEqual(changed.status, 200);
        assert.isNull((yield* currentSession(firstCookie)).value);
        assert.isNotNull((yield* currentSession(cookieOf(changed))).value);
        assert.isNull((yield* currentSession(thirdCookie)).value);
      })
  );

  it.effect(
    "negative control: removing the Better Auth session-creation hook admits an Invited account",
    () =>
      Effect.gen(function* guardMutation() {
        const url = yield* TestDatabaseUrl;

        const mutant = yield* mutantAuth(url);
        assert.isTrue(
          Reflect.deleteProperty(
            mutant.options.databaseHooks.session.create,
            "before"
          )
        );

        const response = yield* Effect.tryPromise(() =>
          mutant.handler(signInRequest("invited@example.org", fixturePassword))
        ).pipe(Effect.orDie);

        assert.strictEqual(response.status, 200);
        const sql = yield* SqlClient;
        yield* sql`delete from auth_session where user_id = 'auth-101'`;
      }).pipe(Effect.scoped)
  );

  it.effect(
    "an overdue valid session is read-only; enabling refresh fails under SELECT-only",
    () =>
      Effect.gen(function* readonlySession() {
        const sql = yield* SqlClient;
        yield* sql`update account set state = 'Active' where person_id = 102`;
        yield* sql`update auth_account set password = ${bcryptFixtures[0]} where user_id = 'auth-102'`;
        const signedIn = yield* signIn("active@example.org", fixturePassword);
        assert.strictEqual(signedIn.status, 200);
        const cookie = cookieOf(signedIn);
        yield* sql`update auth_session set expires_at = now() + interval '363 days', updated_at = now() - interval '2 days' where user_id = 'auth-102'`;
        const reader = yield* ReadOnlyDatabaseUrl;

        const readerLayer = authLayer({
          BETTER_AUTH_SECRET: secret,
          HYPERDRIVE: { connectionString: Redacted.value(reader) },
          SITE_URL: origin,
        }).pipe(
          Layer.provideMerge(DatabaseLive({ maxConnections: 2, url: reader })),
          Layer.orDie
        );

        const headers = new Headers({ cookie });

        const principal = yield* resolvePrincipal(
          "production",
          undefined,
          headers
        ).pipe(Effect.provide(readerLayer));

        assert.isTrue(Predicate.isTagged(principal, "Person"));

        const mutant = yield* mutantAuth(reader);
        assert.isTrue(
          Reflect.set(mutant.options.session, "disableSessionRefresh", false)
        );
        assert.isTrue(
          Reflect.set(mutant.options.session, "deferSessionRefresh", false)
        );

        const refreshed = yield* Effect.exit(
          Effect.tryPromise(() => mutant.api.getSession({ headers }))
        );

        assert.isTrue(Exit.isFailure(refreshed));
        assert.include(inspect(refreshed, { depth: 12 }), "permission denied");
      }).pipe(Effect.scoped)
  );

  it.effect(
    "an aborted in-flight sign-in finishes the foreign transaction before interruption is reported",
    () =>
      Effect.gen(function* abortedSignIn() {
        const sql = yield* SqlClient;
        const url = yield* TestDatabaseUrl;
        yield* sql`update account set state = 'Active' where person_id = 102`;
        yield* sql`update auth_account set password = ${bcryptFixtures[0]} where user_id = 'auth-102'`;
        yield* sql`delete from auth_session where user_id = 'auth-102'`;

        const before =
          yield* sql`select to_jsonb(p) as person, to_jsonb(a) as account from person p join account a on a.person_id = p.id where p.id = 102`;

        const auditBefore =
          yield* sql`select to_jsonb(a) as audit from audit_log a where person_id = 102 order by id`;

        const locked = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();

        const lockerContext = yield* Layer.build(
          PgClient.layer({ maxConnections: 1, prepare: false, url })
        );

        const locker = Context.get(lockerContext, PgClient.PgClient);
        yield* locker
          .withTransaction(
            Effect.gen(function* holdSessionLock() {
              yield* locker`lock table auth_session in access exclusive mode`;
              yield* Deferred.succeed(locked, true);
              yield* Deferred.await(release);
            })
          )
          .pipe(Effect.orDie, Effect.forkScoped);
        yield* Deferred.await(locked);

        const auth = yield* Auth;

        const { controller, fiber } = yield* Effect.sync(() =>
          startAbortable(auth.handle)
        );

        const waiting = Schema.Struct({ blocked: Schema.Boolean });
        let blocked = false;

        for (const _attempt of Arr.range(1, 100)) {
          const rows =
            yield* sql`select exists (select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%auth_session%') as blocked`;

          const status = yield* Schema.decodeUnknownEffect(waiting)(
            rows[0]
          ).pipe(Effect.orDie);

          const { blocked: isBlocked } = status;
          blocked = isBlocked;

          if (blocked) {
            break;
          }

          yield* Effect.sleep("50 millis");
        }

        assert.isTrue(
          blocked,
          "sign-in reached the locked session insert before abort"
        );
        controller.abort();
        assert.isTrue(
          Option.isNone(
            yield* Fiber.await(fiber).pipe(Effect.timeoutOption("100 millis"))
          )
        );
        yield* Deferred.succeed(release, true);
        const result = yield* Fiber.await(fiber);
        assert.isTrue(
          Exit.isFailure(result),
          "the disconnected caller receives no cookie"
        );

        const sessions = yield* (yield* SessionDirectory).byPerson(
          PersonId.make(102),
          yield* DateTime.now
        );

        assert.strictEqual(sessions.length, 1);
        assert.strictEqual(sessions[0]?.userAgent, "aborted-client");

        const expiry =
          yield* sql`select expires_at > now() and expires_at < now() + interval '366 days' as normal from auth_session where user_id = 'auth-102'`;

        assert.isTrue(
          (yield* Schema.decodeUnknownEffect(
            Schema.Struct({ normal: Schema.Boolean })
          )(expiry[0]).pipe(Effect.orDie)).normal
        );
        assert.deepStrictEqual(
          yield* sql`select to_jsonb(p) as person, to_jsonb(a) as account from person p join account a on a.person_id = p.id where p.id = 102`,
          before
        );
        assert.deepStrictEqual(
          yield* sql`select to_jsonb(a) as audit from audit_log a where person_id = 102 order by id`,
          auditBefore
        );
      }).pipe(Effect.scoped)
  );

  it.effect(
    "RULE-112: only an Active private address queues a reset; deactivation invalidates its code",
    () =>
      Effect.gen(function* resetPrivacy() {
        const sql = yield* SqlClient;
        yield* sql`update account set state = 'Active' where person_id = 102`;
        yield* sql`update person set company_email = 'company@example.org' where id = 102`;
        yield* sql`delete from outbox where kind = 'IssueCode'`;

        for (const email of [
          "active@example.org",
          "invited@example.org",
          "deactivated@example.org",
          "unknown@example.org",
          "company@example.org",
        ]) {
          const result = yield* Effect.exit(
            transacted(
              AccountEndpoints.requestPasswordReset({ email }).pipe(
                Effect.provideService(CurrentPrincipal, anonymous)
              )
            )
          );

          assert.isTrue(Exit.isSuccess(result), email);
        }

        const rows =
          yield* sql`select payload from outbox where kind = 'IssueCode'`;

        assert.strictEqual(rows.length, 1);

        const pending = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            payload: Schema.Struct({
              personId: Schema.Finite,
              purpose: Schema.String,
            }),
          })
        )(rows[0]).pipe(Effect.orDie);

        assert.strictEqual(pending.payload.personId, 102);
        assert.strictEqual(pending.payload.purpose, "resetPassword");

        const code = yield* mintCode().pipe(
          Effect.provide(webCryptoLayer),
          Effect.orDie
        );

        const now = yield* DateTime.now;
        yield* transacted(
          Effect.gen(function* storeCode() {
            const locked = yield* (yield* AggregateLocks).lock(
              "Person",
              PersonId.make(102)
            );

            yield* (yield* CodeRepository).replace(locked, {
              expiresAt: DateTime.add(now, { hours: 24 }),
              hash: code.hash,
              purpose: "resetPassword",
            });
          })
        );
        yield* sql`update account set state = 'Deactivated' where person_id = 102`;

        const use = yield* Effect.exit(
          transacted(
            AccountEndpoints.resetPassword({
              code: code.token,
              password: "valid password",
            })
          ).pipe(
            Effect.provide(Layer.merge(webCryptoLayer, passwordHasherLayer))
          )
        );

        assert.isTrue(Exit.isFailure(use));
        assert.isTrue(
          Option.exists(
            Exit.findErrorOption(use),
            Predicate.isTagged("Forbidden")
          )
        );
      })
  );

  it.effect(
    "a code that opens nothing is refused, and the refusal names the command of the code's purpose (spec 0007c R2)",
    () =>
      Effect.gen(function* unknownCode() {
        const code = yield* mintCode().pipe(
          Effect.provide(webCryptoLayer),
          Effect.orDie
        );

        const provided = Effect.provide(
          Layer.merge(webCryptoLayer, passwordHasherLayer)
        );

        const activation = yield* Effect.exit(
          transacted(
            AccountEndpoints.activateAccount({
              code: code.token,
              password: "valid password",
            })
          ).pipe(provided)
        );

        const reset = yield* Effect.exit(
          transacted(
            AccountEndpoints.resetPassword({
              code: code.token,
              password: "valid password",
            })
          ).pipe(provided)
        );

        assert.deepStrictEqual(
          [refusedCommand(activation), refusedCommand(reset)],
          [Option.some("activateAccount"), Option.some("resetPassword")]
        );
      })
  );

  it.effect(
    "credential delivery revokes sessions once and fences duplicate or older intents",
    () =>
      Effect.gen(function* credentialDelivery() {
        const sql = yield* SqlClient;
        yield* sql`update account set state = 'Active' where person_id = 102`;
        yield* sql`update auth_account set password = ${bcryptFixtures[0]}, credential_version = 0 where user_id = 'auth-102'`;
        const previous = yield* signIn("active@example.org", fixturePassword);
        const previousCookie = cookieOf(previous);

        const hash = yield* Effect.tryPromise(() =>
          hashPassword("fresh credential password")
        ).pipe(Effect.orDie);

        const auth = yield* Auth;

        const input = {
          at: yield* DateTime.now,
          passwordHash: PasswordHash.make(hash),
          personId: PersonId.make(102),
          revokeSessions: true,
          version: 20,
        };

        yield* auth.setCredential(input).pipe(Effect.orDie);
        assert.isNull((yield* currentSession(previousCookie)).value);

        const current = yield* signIn(
          "active@example.org",
          "fresh credential password"
        );

        assert.strictEqual(current.status, 200);
        const currentCookie = cookieOf(current);
        yield* auth.setCredential(input).pipe(Effect.orDie);
        yield* auth
          .setCredential({
            ...input,
            passwordHash: PasswordHash.make(bcryptFixtures[0]),
            version: 19,
          })
          .pipe(Effect.orDie);
        assert.isNotNull((yield* currentSession(currentCookie)).value);
        assert.strictEqual(
          (yield* signIn("active@example.org", fixturePassword)).status,
          401
        );
      })
  );

  it.effect(
    "private and company addresses sign in, but a replaced private address is no longer an alias",
    () =>
      Effect.gen(function* emailAliases() {
        const sql = yield* SqlClient;
        yield* sql`update account set state = 'Active' where person_id = 102`;
        yield* sql`update auth_account set password = ${bcryptFixtures[0]} where user_id = 'auth-102'`;
        yield* sql`update person set email = 'active@example.org', company_email = 'company@example.org' where id = 102`;
        assert.strictEqual(
          (yield* signIn("active@example.org", fixturePassword)).status,
          200
        );
        assert.strictEqual(
          (yield* signIn("company@example.org", fixturePassword)).status,
          200
        );
        yield* sql`update person set email = 'new-private@example.org' where id = 102`;
        assert.strictEqual(
          (yield* signIn("new-private@example.org", fixturePassword)).status,
          200
        );
        assert.strictEqual(
          (yield* signIn("active@example.org", fixturePassword)).status,
          401
        );
      })
  );

  it.effect(
    "an address that two identities answer to is refused like a wrong password",
    () =>
      Effect.gen(function* ambiguousAddress() {
        const sql = yield* SqlClient;
        yield* sql`update account set state = 'Active' where person_id = 102`;
        yield* sql`update auth_account set password = ${bcryptFixtures[0]} where user_id = 'auth-102'`;

        const wrong = yield* signIn(
          "new-private@example.org",
          "not the password"
        );

        const wrongBody = yield* text(wrong);

        // Person 102's private address is person 103's company address too: two identities answer to it.
        yield* sql`update person set email = 'shared@example.org' where id = 102`;
        yield* sql`update person set company_email = 'shared@example.org' where id = 103`;
        const refused = yield* signIn("shared@example.org", fixturePassword);

        yield* sql`update person set email = 'new-private@example.org' where id = 102`;
        yield* sql`update person set company_email = null where id = 103`;

        assert.strictEqual(refused.status, wrong.status);
        assert.strictEqual(yield* text(refused), wrongBody);

        const admitted = yield* signIn(
          "new-private@example.org",
          fixturePassword
        );

        assert.strictEqual(admitted.status, 200);
      })
  );

  it.effect(
    "signInPerson signs a person in by the address of their own identity, and refuses a person without one",
    () =>
      Effect.gen(function* signInByPerson() {
        const sql = yield* SqlClient;
        yield* sql`update account set state = 'Active' where person_id = 102`;
        yield* sql`update auth_account set password = ${bcryptFixtures[0]} where user_id = 'auth-102'`;
        // After activation the person's private address is the identity's own, which is what `signInPerson` signs in by.
        yield* sql`update person set email = 'active@example.org', company_email = null where id = 102`;
        yield* sql`insert into person ${sql.insert({
          email: "ingen@example.org",
          email_verified: true,
          field_of_study_id: 101,
          id: 104,
          name: "Ingen Identitet",
        })}`;
        const auth = yield* Auth;

        const signedIn = yield* auth.signInPerson({
          headers: new Headers({ origin, "user-agent": "person-client" }),
          password: fixturePassword,
          personId: PersonId.make(102),
        });

        assert.strictEqual(signedIn.status, 200);
        assert.isTrue(Predicate.isString(cookieOf(signedIn)));

        const refused = yield* Effect.flip(
          auth.signInPerson({
            headers: new Headers({ origin }),
            password: fixturePassword,
            personId: PersonId.make(104),
          })
        );

        assert.strictEqual(refused._tag, "AuthBoundaryFailure");
        yield* sql`delete from person where id = 104`;
      })
  );

  it.effect(
    "Better Auth's pool is a role with privileges on its four tables and on no domain table",
    () =>
      Effect.gen(function* poolRole() {
        const authUrl = yield* AuthTablesDatabaseUrl;

        const read = (table: string) =>
          Effect.exit(
            withClient(authUrl, (client) =>
              client.unsafe(`select 1 from ${table} limit 1`)
            )
          );

        // The control: the restriction bites on the domain's tables, and does not on Better Auth's own.
        for (const table of ["person", "account", "membership", "audit_log"]) {
          assertPermissionDenied(yield* read(table));
        }

        for (const table of AUTH_TABLES) {
          assert.isTrue(Exit.isSuccess(yield* read(table)));
        }
      })
  );

  it.effect(
    "a store that is down admits no one: the session hook rejects and no session is written",
    () =>
      Effect.gen(function* failClosed() {
        const sql = yield* SqlClient;
        const url = yield* TestDatabaseUrl;
        yield* sql`update account set state = 'Active' where person_id = 102`;
        yield* sql`update auth_account set password = ${bcryptFixtures[0]} where user_id = 'auth-102'`;
        yield* sql`delete from auth_session where user_id = 'auth-102'`;
        const failing = yield* FiberSet.makeRuntimePromise();

        const pool = yield* Effect.acquireRelease(
          Effect.sync(
            () => new Pool({ connectionString: Redacted.value(url) })
          ),
          (owned) => Effect.promise(() => owned.end())
        );

        // Every domain read of this instance dies, as it does when the database is unreachable.
        const down = makeAuth(pool, secret, origin, () =>
          failing(Effect.die("the store is down"))
        );

        const attempt = yield* Effect.exit(
          Effect.tryPromise(() =>
            down.handler(
              signInRequest("new-private@example.org", fixturePassword)
            )
          )
        );

        const admitted =
          Exit.isSuccess(attempt) && attempt.value.status === 200;

        assert.isFalse(admitted);

        const sessions =
          yield* sql`select id from auth_session where user_id = 'auth-102'`;

        assert.lengthOf(sessions, 0);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "missing or short signing secrets fail closed before opening a deployed auth pool",
    () =>
      Effect.gen(function* missingSecret() {
        const missing = new Map<string, string>().get("BETTER_AUTH_SECRET");

        assert.isFalse(isAuthSecret(missing));
        assert.isFalse(isAuthSecret(""));
        assert.isFalse(isAuthSecret("too-short"));
        assert.isTrue(isAuthSecret(secret));

        const absent = authLayer({
          BETTER_AUTH_SECRET: "",
          HYPERDRIVE: { connectionString: "postgres://invalid" },
          SITE_URL: origin,
        });

        const result = yield* Layer.build(absent).pipe(
          Effect.scoped,
          Effect.exit
        );

        assert.isTrue(Exit.isFailure(result));
        assert.isTrue(
          Option.exists(
            Exit.findErrorOption(result),
            Predicate.isTagged("AuthBoundaryFailure")
          )
        );
      })
  );
});
