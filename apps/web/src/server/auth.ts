/**
 * EX-0017: Better Auth's Promise/pg ABI has no cancellation signal. Every library call runs to completion in an
 * uninterruptible Effect, with a per-request pool closed by the owning scope. Retire when Better Auth forwards
 * request cancellation to its adapter. Credential deliveries use the library adapter after domain commit.
 */
import type { BetterAuthOptions } from "@better-auth/core";
import type { DBTransactionAdapter } from "@better-auth/core/db/adapter";
import { BASE_ERROR_CODES } from "@better-auth/core/error";
import { PersonId, passwordAllowed } from "@vektorprogrammet/domain";
import type { PasswordHash } from "@vektorprogrammet/domain";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { getSessionCookie } from "better-auth/cookies";
import { Context, DateTime, Effect, Layer, Predicate, Schema } from "effect";
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
const StateRow = Schema.NullOr(Schema.Struct({ state: Schema.String }));
const isStateRow = Schema.is(StateRow);
const decodeStateEffect = Schema.decodeUnknownEffect(StateRow);

const isAliases = Schema.is(
  Schema.Array(Schema.Struct({ email: Schema.String }))
);

const decodeCanonicalEmail = Schema.decodeUnknownEffect(
  Schema.Struct({ email: Schema.String })
);

const Profile = Schema.Struct({
  email: Schema.String,
  email_verified: Schema.Boolean,
  id: PersonId,
  name: Schema.String,
});

const decodeProfile = Schema.decodeUnknownEffect(Profile);
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
  profile: typeof Profile.Type,
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
            emailVerified: profile.email_verified,
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

/** Test mutations create their own instance; the live Layer always uses this unmodified configuration. */
export const makeAuth = (pool: Pool, secret: string, siteUrl: string) =>
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
            pool
              .query(
                "select a.state from auth_user u join account a on a.person_id = u.person_id where u.id = $1",
                [session.userId]
              )
              .then(({ rows }) => {
                const state: unknown = rows[0] ?? null;

                if (!isStateRow(state) || state?.state !== "Active") {
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

        return pool
          .query(
            "select u.email from person p join auth_user u on u.person_id = p.id where p.email = $1 or p.company_email = $1 limit 2",
            [email]
          )
          .then<string | { readonly email: string }>(({ rows }) => {
            const aliases: unknown = rows;

            if (!isAliases(aliases)) {
              throw invalidCredentials();
            }

            const [first] = aliases;

            if (first === undefined || aliases.length > 1) {
              return hashPassword(body.password);
            }

            return { email: first.email };
          })
          .then((alias) => {
            if (Predicate.isString(alias)) {
              throw invalidCredentials();
            }

            return { context: { body: { ...body, email: alias.email } } };
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

export class Auth extends Context.Service<
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
>()("@vektorprogrammet/web/server/Auth") {}

interface AuthEnvironment extends Pick<
  WorkerEnv,
  "BETTER_AUTH_SECRET" | "SITE_URL"
> {
  readonly HYPERDRIVE: Pick<WorkerEnv["HYPERDRIVE"], "connectionString">;
}

/** One pool and one Better Auth instance per owned Worker request or delivery scope. */
export const authLayer = (
  env: AuthEnvironment
): Layer.Layer<Auth, AuthBoundaryFailure> =>
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

      const auth = makeAuth(pool, env.BETTER_AUTH_SECRET, env.SITE_URL);

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

        const rows = yield* foreign(() =>
          pool.query("select state from account where person_id = $1", [
            personId,
          ])
        );

        const state = yield* decodeStateEffect(rows.rows[0] ?? null).pipe(
          Effect.mapError((cause) => new AuthBoundaryFailure({ cause }))
        );

        if (state?.state === "Active") {
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
          const rows = yield* foreign(() =>
            pool.query("select email from auth_user where person_id = $1", [
              input.personId,
            ])
          );

          const { email } = yield* decodeCanonicalEmail(rows.rows[0]).pipe(
            Effect.mapError((cause) => new AuthBoundaryFailure({ cause }))
          );

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
          const rows = yield* foreign(() =>
            pool.query(
              "select id, name, email, email_verified from person where id = $1",
              [input.personId]
            )
          );

          const profile = yield* decodeProfile(rows.rows[0]).pipe(
            Effect.mapError((cause) => new AuthBoundaryFailure({ cause }))
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
