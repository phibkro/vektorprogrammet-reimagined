/** Supabase Auth owns credentials and sessions; domain account state remains authoritative. */
import {
  createClient,
  isAuthApiError,
  isAuthSessionMissingError,
} from "@supabase/supabase-js";
import type { AuthError } from "@supabase/supabase-js";
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";

import {
  createRequestClient,
  createWorkerClient,
} from "../../adapters/supabase/clients";
import type { SupabaseConfig } from "../../adapters/supabase/clients";
import { PersonId } from "../../core/ids";
import { refusingInTransaction } from "../../core/transactions/integrationGuard";
import type {
  IntegrationPort,
  IntegrationTypeId as IntegrationType,
  IntegrationTypeId,
} from "../../core/transactions/transaction";
import { passwordAllowed } from "../../features/accounts/domain/entities";
import { AccountRepository } from "../../features/accounts/domain/services";
import { SignInDirectory } from "../../features/accounts/domain/signInDirectory";
import type { SignInMatch } from "../../features/accounts/domain/signInDirectory";
import { AuthBoundaryFailure } from "./authError";

export type AuthEnvironment = SupabaseConfig & { readonly SITE_URL: string };

/** Only classify errors from getUser with a stored session. `validation_failed` here can mean a malformed refresh token. */
export const sessionFailure = (error: AuthError) => {
  if (
    isAuthSessionMissingError(error) ||
    (isAuthApiError(error) &&
      error.status >= 400 &&
      error.status < 500 &&
      (error.code === "refresh_token_not_found" ||
        error.code === "refresh_token_already_used" ||
        error.code === "session_expired" ||
        error.code === "session_not_found" ||
        error.code === "bad_jwt" ||
        error.code === "validation_failed"))
  ) {
    return Effect.succeed(null);
  }

  return Effect.fail(new AuthBoundaryFailure({ cause: error }));
};

const decodeMetadata = Schema.decodeUnknownOption(
  Schema.Struct({ personId: PersonId })
);

const bodySchema = Schema.Struct({
  captchaToken: Schema.optionalKey(Schema.String),
  currentPassword: Schema.optionalKey(Schema.String),
  email: Schema.optionalKey(Schema.String),
  newPassword: Schema.optionalKey(Schema.String),
  password: Schema.optionalKey(Schema.String),
  tokenHash: Schema.optionalKey(Schema.String),
});

const decodeBody = Schema.decodeUnknownOption(bodySchema);

type AuthBody = typeof bodySchema.Type;

type WorkerClient = ReturnType<typeof createWorkerClient>;

const foreign = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new AuthBoundaryFailure({ cause }),
    try: operation,
  });

export const wrongPasswordResponse = () =>
  Response.json({ message: "Feil e-post eller passord." }, { status: 401 });

/** Normalize status and body without logging addresses or provider errors. */
export const recoveryResponse = (
  match: SignInMatch,
  send: (email: string) => Effect.Effect<void, AuthBoundaryFailure>,
  headers: Headers = new Headers()
) =>
  Effect.gen(function* normalizeRecoveryResponse() {
    if (Predicate.isTagged(match, "Unique")) {
      yield* send(match.email).pipe(
        Effect.catchTag("AuthBoundaryFailure", () =>
          Effect.logWarning("Supabase recovery delivery failed")
        )
      );
    }

    return Response.json({ ok: true }, { headers });
  });

export class Auth
  extends Context.Service<
    Auth,
    {
      readonly session: (
        headers: Headers
      ) => Effect.Effect<
        { readonly cookiePresent: boolean; readonly personId: PersonId | null },
        AuthBoundaryFailure
      >;
      readonly handle: (
        request: Request
      ) => Effect.Effect<Response, AuthBoundaryFailure>;
    }
  >()("@vektorprogrammet/web/server/Auth")
  implements IntegrationPort
{
  declare readonly [IntegrationTypeId]: IntegrationType;
}

const changePassword = (
  body: AuthBody,
  client: WorkerClient,
  headers: Headers,
  hasEmail: boolean
) =>
  Effect.gen(function* changePasswordOperation() {
    const { currentPassword, newPassword } = body;

    if (
      currentPassword === undefined ||
      currentPassword === "" ||
      newPassword === undefined ||
      newPassword === "" ||
      !passwordAllowed(newPassword) ||
      !hasEmail
    ) {
      return new Response("Bad Request", { headers, status: 400 });
    }

    const updated = yield* foreign(() =>
      client.auth.updateUser({
        current_password: currentPassword,
        password: newPassword,
      })
    );

    if (updated.error) {
      return Response.json(
        { message: "Kunne ikke endre passordet." },
        { headers, status: 400 }
      );
    }

    const revoked = yield* foreign(() =>
      client.auth.signOut({ scope: "others" })
    );

    if (revoked.error) {
      return Response.json(
        {
          message: "Passordet er endret, men andre økter kunne ikke avsluttes.",
        },
        { headers, status: 500 }
      );
    }

    return Response.json({ ok: true }, { headers });
  });

const signOutScope = (path: string) =>
  path.endsWith("sign-out") ? "local" : "others";

const signOut = (
  client: WorkerClient,
  headers: Headers,
  scope: "local" | "others"
) =>
  Effect.gen(function* signOutOperation() {
    const result = yield* foreign(() => client.auth.signOut({ scope }));

    return result.error
      ? Response.json(
          { message: "Kunne ikke avslutte økten." },
          { headers, status: 400 }
        )
      : Response.json({ ok: true }, { headers });
  });

const makeAuth = (
  env: AuthEnvironment,
  accounts: typeof AccountRepository.Service,
  directory: typeof SignInDirectory.Service
) => {
  const active = (personId: PersonId) =>
    Effect.map(accounts.find(personId), (account) =>
      Option.exists(account, (value) =>
        Predicate.isTagged(value.state, "Active")
      )
    );

  const session = Effect.fn("Auth.session")(function* session(
    headers: Headers
  ) {
    const cookiePresent = /(?:^|;\s*)sb-[^=]*auth-token(?:\.\d+)?=/u.test(
      headers.get("cookie") ?? ""
    );

    if (!cookiePresent) {
      return { cookiePresent, personId: null };
    }

    // The SSR client removes an expired session after a non-retryable refresh failure
    // and flushes the resulting SIGNED_OUT cookie update through its configured adapter.
    const result = yield* foreign(() =>
      createRequestClient(env).auth.getUser()
    );

    if (result.error) {
      const personId = yield* sessionFailure(result.error);

      return { cookiePresent, personId };
    }

    const personId = Option.getOrNull(
      Option.map(
        decodeMetadata(result.data.user.app_metadata),
        (metadata) => metadata.personId
      )
    );

    return {
      cookiePresent,
      personId,
    };
  });

  const signIn = (body: AuthBody, client: WorkerClient, headers: Headers) =>
    Effect.gen(function* signInOperation() {
      const { email, password } = body;

      if (
        email === undefined ||
        email === "" ||
        password === undefined ||
        password === ""
      ) {
        return wrongPasswordResponse();
      }

      const match = yield* directory.match(email.toLowerCase());

      if (!Predicate.isTagged(match, "Unique")) {
        return wrongPasswordResponse();
      }

      const result = yield* foreign(() =>
        client.auth.signInWithPassword({
          email: match.email,
          password,
        })
      );

      if (result.error) {
        return wrongPasswordResponse();
      }

      const id = Option.getOrNull(
        Option.map(
          decodeMetadata(result.data.user.app_metadata),
          (metadata) => metadata.personId
        )
      );

      if (id === null || !(yield* active(id))) {
        yield* foreign(() => client.auth.signOut({ scope: "local" }));

        return Response.json(
          { message: "Feil e-post eller passord." },
          { headers, status: 401 }
        );
      }

      return Response.json({ ok: true }, { headers });
    });

  const requestReset = (body: AuthBody, headers: Headers) =>
    Effect.gen(function* requestResetOperation() {
      const { email } = body;

      if (email === undefined || email === "") {
        return new Response("Bad Request", { status: 400 });
      }

      const match = yield* directory.match(email.toLowerCase());

      const recovery = createClient(
        env.SUPABASE_URL,
        env.SUPABASE_PUBLISHABLE_KEY,
        {
          auth: {
            autoRefreshToken: false,
            flowType: "implicit",
            persistSession: false,
          },
        }
      );

      const options: NonNullable<
        Parameters<typeof recovery.auth.resetPasswordForEmail>[1]
      > = { redirectTo: `${env.SITE_URL}/auth/confirm?flow=recovery` };

      if (body.captchaToken !== undefined) {
        options.captchaToken = body.captchaToken;
      }

      return yield* recoveryResponse(
        match,
        (recipient) =>
          foreign(() =>
            recovery.auth.resetPasswordForEmail(recipient, options)
          ).pipe(
            Effect.flatMap((sent) =>
              sent.error
                ? Effect.fail(new AuthBoundaryFailure({ cause: sent.error }))
                : Effect.void
            )
          ),
        headers
      );
    });

  const resetPassword = (body: AuthBody) =>
    Effect.gen(function* resetPasswordOperation() {
      const { tokenHash, newPassword } = body;

      if (
        tokenHash === undefined ||
        tokenHash === "" ||
        newPassword === undefined ||
        newPassword === "" ||
        !passwordAllowed(newPassword)
      ) {
        return new Response("Bad Request", { status: 400 });
      }

      const recovery = createClient(
        env.SUPABASE_URL,
        env.SUPABASE_PUBLISHABLE_KEY,
        { auth: { autoRefreshToken: false, persistSession: false } }
      );

      const verified = yield* foreign(() =>
        recovery.auth.verifyOtp({
          token_hash: tokenHash,
          type: "recovery",
        })
      );

      const personId = Option.getOrNull(
        Option.map(
          decodeMetadata(verified.data.user?.app_metadata),
          (metadata) => metadata.personId
        )
      );

      if (verified.error || personId === null || !(yield* active(personId))) {
        return wrongPasswordResponse();
      }

      const updated = yield* foreign(() =>
        recovery.auth.updateUser({ password: newPassword })
      );

      if (updated.error) {
        return Response.json(
          { message: "Kunne ikke endre passordet." },
          { status: 400 }
        );
      }

      const revoked = yield* foreign(() =>
        recovery.auth.signOut({ scope: "global" })
      );

      if (revoked.error) {
        return Response.json(
          {
            message: "Passordet er endret, men øktene kunne ikke avsluttes.",
          },
          { status: 500 }
        );
      }

      return Response.json({ ok: true });
    });

  const authenticatedAction = (
    path: string,
    body: AuthBody,
    client: WorkerClient,
    headers: Headers
  ) =>
    Effect.gen(function* authenticatedActionOperation() {
      const current = yield* foreign(() => client.auth.getUser());

      const id = Option.getOrNull(
        Option.map(
          decodeMetadata(current.data.user?.app_metadata),
          (metadata) => metadata.personId
        )
      );

      if (current.error || id === null || !(yield* active(id))) {
        return wrongPasswordResponse();
      }

      if (
        path === "/api/auth/sign-out" ||
        path === "/api/auth/revoke-other-sessions"
      ) {
        return yield* signOut(client, headers, signOutScope(path));
      }

      if (path === "/api/auth/change-password") {
        return yield* changePassword(
          body,
          client,
          headers,
          current.data.user?.email !== undefined &&
            current.data.user.email !== ""
        );
      }

      return new Response("Not Found", { status: 404 });
    });

  const handle = Effect.fn("Auth.handle")(function* handle(request: Request) {
    if (
      request.method !== "POST" ||
      request.headers.get("origin") !== new URL(request.url).origin
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    const path = new URL(request.url).pathname;
    const headers = new Headers();
    const client = createWorkerClient(env, request, headers);
    const json: unknown = yield* foreign(() => request.json());
    const decoded = decodeBody(json);

    if (Option.isNone(decoded)) {
      return new Response("Bad Request", { status: 400 });
    }

    const body = decoded.value;

    if (path === "/api/auth/sign-in/email") {
      return yield* signIn(body, client, headers);
    }

    if (path === "/api/auth/request-reset") {
      return yield* requestReset(body, headers);
    }

    if (path === "/api/auth/reset-password") {
      return yield* resetPassword(body);
    }

    return yield* authenticatedAction(path, body, client, headers);
  });

  return Auth.of({
    handle: (request) =>
      handle(request).pipe(
        Effect.map((response) => {
          response.headers.set("Cache-Control", "no-store");
          response.headers.set("Referrer-Policy", "no-referrer");

          return response;
        })
      ),
    session,
  });
};

export const authLayer = (env: AuthEnvironment) =>
  Layer.effect(
    Auth,
    Effect.gen(function* buildAuth() {
      const accounts = yield* AccountRepository;
      const directory = yield* SignInDirectory;

      return Auth.of(
        refusingInTransaction("Auth", makeAuth(env, accounts, directory))
      );
    })
  );
