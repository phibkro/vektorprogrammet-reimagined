/**
 * EX-0017: Better Auth's Promise/pg ABI has no cancellation signal. Every library call runs to completion in an
 * uninterruptible Effect, with a per-request pool closed by the owning scope. Retire when Better Auth forwards
 * request cancellation to its adapter. Credential deliveries use the library adapter after domain commit. The pool
 * reads and writes Better Auth's four tables only: what the library needs of the domain, its two Promise callbacks ask
 * through `RunDomain` (a `FiberSet.makeRuntimePromise` that the layer's scope owns) and the rest through the ports.
 */
import type { BetterAuthOptions } from "@better-auth/core";
import type { DBTransactionAdapter } from "@better-auth/core/db/adapter";
import { BASE_ERROR_CODES } from "@better-auth/core/error";
import {
  AccountRepository,
  PersonId,
  SignInDirectory,
  passwordAllowed,
} from "@vektorprogrammet/domain";
import type {
  IntegrationPort,
  PasswordHash,
  SignInProfile,
  IntegrationTypeId,
} from "@vektorprogrammet/domain";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { getSessionCookie } from "better-auth/cookies";
import {
  Context,
  DateTime,
  Effect,
  FiberSet,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { Pool } from "pg";

import { AuthBoundaryFailure } from "./authError";
import { isAuthSecret } from "./authStartup";
import type { WorkerEnv } from "./env";
import { exceedsBcryptLimit, hashPassword, verifyPassword } from "./password";

const YEAR_SECONDS = 365 * 24 * 60 * 60;

const tooShort = (password: string): boolean => {
  let characters = 0;

  for (const _character of password) {
    characters += 1;

    if (characters === 8) {
      return false;
    }
  }

  return true;
};

const SignInBody = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
});

const ChangePasswordBody = Schema.Struct({ newPassword: Schema.String });
const isSignInBody = Schema.is(SignInBody);
const isChangePasswordBody = Schema.is(ChangePasswordBody);

const ForeignSession = Schema.NullOr(
  Schema.Struct({
    session: Schema.Struct({ id: Schema.NonEmptyString }),
    user: Schema.Struct({ personId: PersonId }),
  })
);

const decodeSession = Schema.decodeUnknownEffect(ForeignSession);
const ForeignUser = Schema.Struct({ id: Schema.NonEmptyString });
const isForeignUser = Schema.is(ForeignUser);
const ForeignCredential = Schema.Struct({ id: Schema.NonEmptyString });
const isForeignCredential = Schema.is(ForeignCredential);

/** The same body and status Better Auth returns for a wrong e-mail or password. */
export const wrongPasswordResponse = (): Response => {
  const error = APIError.from(
    "UNAUTHORIZED",
    BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD
  );

  return Response.json(error.body, {
    status: error.statusCode,
    statusText: String(error.status),
  });
};

const invalidCredentials = () =>
  APIError.from("UNAUTHORIZED", BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);

/** Reads and writes on this foreign ABI do not accept AbortSignal; do not report interruption before completion. */
const foreign = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new AuthBoundaryFailure({ cause }),
    try: operation,
  }).pipe(Effect.uninterruptible);

interface CredentialInput {
  readonly personId: PersonId;
  readonly passwordHash: PasswordHash;
  readonly revokeSessions: boolean;
  readonly version: number;
  readonly at: DateTime.Utc;
}

/** EX-0017: Better Auth calls these Promise callbacks inside its own adapter transaction. */
const writeCredential = <Options extends BetterAuthOptions>(
  tx: DBTransactionAdapter<Options>,
  userId: string,
  input: CredentialInput,
  at: Date,
  found: typeof ForeignCredential.Type | null
): Promise<boolean> => {
  if (found === null) {
    return tx
      .create({
        data: {
          accountId: userId,
          createdAt: at,
          credentialVersion: input.version,
          password: input.passwordHash,
          providerId: "credential",
          updatedAt: at,
          userId,
        },
        model: "account",
      })
      .then(() => true);
  }

  return tx
    .incrementOne({
      increment: {},
      model: "account",
      set: {
        credentialVersion: input.version,
        password: input.passwordHash,
        updatedAt: at,
      },
      where: [
        { field: "id", value: found.id },
        { field: "credentialVersion", operator: "lt", value: input.version },
      ],
    })
    .then((updated) => updated !== null);
};

const updateCredential = <Options extends BetterAuthOptions>(
  tx: DBTransactionAdapter<Options>,
  userId: string,
  input: CredentialInput,
  at: Date
) =>
  tx
    .findOne<unknown>({
      model: "account",
      where: [
        { field: "userId", value: userId },
        { field: "providerId", value: "credential" },
      ],
    })
    .then((found) => {
      if (found !== null && !isForeignCredential(found)) {
        throw new AuthBoundaryFailure({
          cause: "Better Auth returned an invalid credential",
        });
      }

      return writeCredential(tx, userId, input, at, found);
    })
    .then((updated) =>
      updated && input.revokeSessions
        ? tx.deleteMany({
            model: "session",
            where: [{ field: "userId", value: userId }],
          })
        : 0
    );

const applyCredentialTransaction = <Options extends BetterAuthOptions>(
  tx: DBTransactionAdapter<Options>,
  input: CredentialInput,
  profile: SignInProfile,
  at: Date
) =>
  tx
    .findOne<unknown>({
      model: "user",
      where: [{ field: "personId", value: input.personId }],
    })
    .then(
      (existing) =>
        existing ??
        tx.create({
          data: {
            createdAt: at,
            email: profile.email,
            emailVerified: profile.emailVerified,
            name: profile.name,
            personId: profile.id,
            updatedAt: at,
          },
          model: "user",
        })
    )
    .then((user) => {
      if (!isForeignUser(user)) {
        throw new AuthBoundaryFailure({
          cause: "Better Auth returned an invalid user",
        });
      }

      return updateCredential(tx, user.id, input, at);
    });

const fields = {
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;

/** What a Better Auth callback may ask of the domain: the reads of these two services. */
type DomainReads = AccountRepository | SignInDirectory;

/**
 * Runs a domain read from one of Better Auth's Promise callbacks (EX-0017): `authLayer` builds the runner once, in its
 * own scope, so closing the scope interrupts a read that is still running.
 */
export type RunDomain = <A>(
  effect: Effect.Effect<A, never, DomainReads>
) => Promise<A>;

/** Whether the owner of a Better Auth user holds an Active account: a session is created for no one else. */
const holdsActiveAccount = Effect.fn("Auth.holdsActiveAccount")(
  function* holdsActiveAccount(userId: string) {
    const directory = yield* SignInDirectory;
    const accounts = yield* AccountRepository;
    const owner = yield* directory.personOfUser(userId);

    if (Option.isNone(owner)) {
      return false;
    }

    return Option.exists(yield* accounts.find(owner.value), (account) =>
      Predicate.isTagged(account.state, "Active")
    );
  }
);

/** Test mutations create their own instance; the live Layer always uses this unmodified configuration. */
export const makeAuth = (
  pool: Pool,
  secret: string,
  siteUrl: string,
  run: RunDomain
) =>
  betterAuth({
    account: {
      additionalFields: {
        credentialVersion: {
          defaultValue: 0,
          fieldName: "credential_version",
          input: false,
          required: true,
          type: "number",
        },
      },
      fields: {
        ...fields,
        accessToken: "access_token",
        accessTokenExpiresAt: "access_token_expires_at",
        accountId: "account_id",
        idToken: "id_token",
        providerId: "provider_id",
        refreshToken: "refresh_token",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        userId: "user_id",
      },
      modelName: "auth_account",
    },
    advanced: { ipAddress: { disableIpTracking: true } },
    baseURL: siteUrl === "" ? undefined : siteUrl,
    database: pool,
    databaseHooks: {
      session: {
        create: {
          before: (session) =>
            run(holdsActiveAccount(session.userId)).then((active) => {
              if (!active) {
                throw invalidCredentials();
              }
            }),
        },
      },
    },
    disabledPaths: [
      "/sign-up/email",
      "/request-password-reset",
      "/reset-password",
    ],
    emailAndPassword: {
      disableSignUp: true,
      enabled: true,
      maxPasswordLength: 64,
      minPasswordLength: 8,
      password: { hash: hashPassword, verify: verifyPassword },
      revokeSessionsOnPasswordReset: true,
    },
    hooks: {
      before: createAuthMiddleware((ctx) => {
        const body: unknown = ctx.body;

        if (ctx.path === "/change-password" && isChangePasswordBody(body)) {
          if (!passwordAllowed(body.newPassword)) {
            throw APIError.from(
              "BAD_REQUEST",
              tooShort(body.newPassword)
                ? BASE_ERROR_CODES.PASSWORD_TOO_SHORT
                : BASE_ERROR_CODES.PASSWORD_TOO_LONG
            );
          }

          // oxlint-disable-next-line effect/no-native-promise-control-flow -- EX-0017: Better Auth owns this middleware's Promise ABI.
          return Promise.resolve({
            context: { body: { ...body, revokeOtherSessions: true } },
          });
        }

        if (ctx.path !== "/sign-in/email" || !isSignInBody(body)) {
          // oxlint-disable-next-line effect/no-native-promise-control-flow -- EX-0017: Better Auth owns this middleware's Promise ABI.
          return Promise.resolve();
        }

        if (exceedsBcryptLimit(body.password)) {
          throw invalidCredentials();
        }

        const email = body.email.toLowerCase();

        return run(SignInDirectory.use((directory) => directory.match(email)))
          .then<string | { readonly email: string }>((found) =>
            // Unknown and ambiguous addresses take the time of one hash, so the refusal says nothing about which it was.
            Predicate.isTagged(found, "Unique")
              ? found
              : hashPassword(body.password)
          )
          .then((resolved) => {
            if (Predicate.isString(resolved)) {
              throw invalidCredentials();
            }

            return { context: { body: { ...body, email: resolved.email } } };
          });
      }),
    },
    rateLimit: { enabled: false },
    secret,
    session: {
      deferSessionRefresh: true,
      disableSessionRefresh: true,
      expiresIn: YEAR_SECONDS,
      fields: {
        ...fields,
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id",
      },
      freshAge: 0,
      modelName: "auth_session",
    },
    telemetry: { enabled: false },
    user: {
      additionalFields: {
        personId: {
          fieldName: "person_id",
          input: false,
          required: true,
          type: "number",
        },
      },
      fields: { ...fields, emailVerified: "email_verified" },
      modelName: "auth_user",
    },
    verification: {
      fields: { ...fields, expiresAt: "expires_at" },
      modelName: "auth_verification",
    },
  });

interface AuthRoutes {
  readonly [path: string]: "GET" | "POST" | undefined;
}

const routes: AuthRoutes = {
  "/change-password": "POST",
  "/get-session": "GET",
  "/list-sessions": "GET",
  "/revoke-other-sessions": "POST",
  "/revoke-session": "POST",
  "/revoke-sessions": "POST",
  "/sign-in/email": "POST",
  "/sign-out": "POST",
};

/**
 * Better Auth: an integration (ADR 0015, section 10): it has its own state and rules and writes outside the domain
 * transaction, so `Transactor.run` refuses a program that requires it.
 */
export class Auth
  extends Context.Service<
    Auth,
    {
      readonly session: (headers: Headers) => Effect.Effect<
        {
          readonly cookiePresent: boolean;
          readonly value: typeof ForeignSession.Type;
        },
        AuthBoundaryFailure
      >;
      readonly handle: (
        request: Request
      ) => Effect.Effect<Response, AuthBoundaryFailure>;
      readonly signInPerson: (input: {
        readonly personId: PersonId;
        readonly password: string;
        readonly headers: Headers;
      }) => Effect.Effect<Response, AuthBoundaryFailure>;
      readonly setCredential: (
        input: CredentialInput
      ) => Effect.Effect<void, AuthBoundaryFailure>;
    }
  >()("@vektorprogrammet/web/server/Auth")
  implements IntegrationPort
{
  declare readonly [IntegrationTypeId]: IntegrationTypeId;
}

export interface AuthEnvironment extends Pick<
  WorkerEnv,
  "BETTER_AUTH_SECRET" | "SITE_URL"
> {
  readonly HYPERDRIVE: Pick<WorkerEnv["HYPERDRIVE"], "connectionString">;
}

/**
 * One pool and one Better Auth instance per owned Worker request or delivery scope. The pool is Better Auth's own: it
 * reads and writes the four `auth_*` tables and nothing of the domain. What the library needs to know of a person (is
 * the account Active, which identity answers to an address, the profile an identity is made from) it asks the domain,
 * through `AccountRepository` and `SignInDirectory` (spec 0017).
 */
export const authLayer = (
  env: AuthEnvironment
): Layer.Layer<
  Auth,
  AuthBoundaryFailure,
  AccountRepository | SignInDirectory
> =>
  Layer.effect(
    Auth,
    Effect.gen(function* buildAuth() {
      if (!isAuthSecret(env.BETTER_AUTH_SECRET)) {
        return yield* new AuthBoundaryFailure({
          cause: "BETTER_AUTH_SECRET is missing or too short",
        });
      }

      const pool = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Pool({
              connectionString: env.HYPERDRIVE.connectionString,
              max: 2,
            })
        ),
        (owned) => foreign(() => owned.end()).pipe(Effect.orDie)
      );

      const accounts = yield* AccountRepository;
      const directory = yield* SignInDirectory;
      const run = yield* FiberSet.makeRuntimePromise<DomainReads>();
      const auth = makeAuth(pool, env.BETTER_AUTH_SECRET, env.SITE_URL, run);

      const session = Effect.fn("Auth.session")(function* session(
        headers: Headers
      ) {
        const value = yield* foreign(() => auth.api.getSession({ headers }));

        const decoded = yield* decodeSession(value).pipe(
          Effect.mapError((cause) => new AuthBoundaryFailure({ cause }))
        );

        return {
          cookiePresent: getSessionCookie(headers) !== null,
          value: decoded,
        };
      });

      const sessionRefusal = Effect.fnUntraced(function* sessionRefusal(
        headers: Headers,
        path: string
      ) {
        const current = yield* session(headers);

        if (current.value === null) {
          return null;
        }

        const { personId } = current.value.user;

        const account = yield* accounts.find(personId);

        if (
          Option.exists(account, (found) =>
            Predicate.isTagged(found.state, "Active")
          )
        ) {
          return null;
        }

        return path === "/get-session"
          ? Response.json(null)
          : wrongPasswordResponse();
      });

      const handle = Effect.fn("Auth.handle")(function* handle(
        request: Request
      ) {
        const path = new URL(request.url).pathname.slice("/api/auth".length);

        if (!(path in routes) || routes[path] !== request.method) {
          return new Response("Not Found", { status: 404 });
        }

        if (path !== "/sign-in/email" && path !== "/sign-out") {
          const refusal = yield* sessionRefusal(request.headers, path);

          if (refusal !== null) {
            return refusal;
          }
        }

        return yield* foreign(() => auth.handler(request));
      });

      const signInPerson = Effect.fn("Auth.signInPerson")(
        function* signInPerson(input: {
          readonly personId: PersonId;
          readonly password: string;
          readonly headers: Headers;
        }) {
          const identity = yield* directory.signInEmailOf(input.personId);

          if (Option.isNone(identity)) {
            return yield* new AuthBoundaryFailure({
              cause: "the person has no sign-in identity",
            });
          }

          const email = identity.value;

          return yield* foreign(() =>
            auth.api.signInEmail({
              asResponse: true,
              body: { email, password: input.password, rememberMe: true },
              headers: input.headers,
            })
          );
        }
      );

      const setCredential = Effect.fn("Auth.setCredential")(
        function* setCredential(input: CredentialInput) {
          const profile = yield* Effect.fromOption(
            yield* directory.profileOf(input.personId),
            () =>
              new AuthBoundaryFailure({ cause: "the person does not exist" })
          );

          const context = yield* foreign(() => auth.$context);
          const at = DateTime.toDateUtc(input.at);
          yield* foreign(() =>
            context.adapter.transaction((tx) =>
              applyCredentialTransaction(tx, input, profile, at)
            )
          );
        }
      );

      return Auth.of({ handle, session, setCredential, signInPerson });
    })
  );
