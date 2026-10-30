/** Worker-owned account form endpoints. Commands commit before any Better Auth credential write. */
import type { ExecutionContext } from "@cloudflare/workers-types";
import { AccountEndpoints } from "@vektorprogrammet/domain";
import type { PersonId } from "@vektorprogrammet/domain";
import { Array as Arr, Effect, Option, Predicate, Schema } from "effect";

import { ChoosePasswordForm, RequestResetForm } from "../forms/account";
import type { Failure } from "../lib/outcome";
import { wrongPasswordResponse } from "./auth";
import { prepareHuman } from "./contact";
import type { WorkerEnv } from "./env";
import {
  liveRequestLayer,
  runCommandOutcome,
  runDeliveryChecked,
  runPreparedCommand,
  runSignInPerson,
} from "./runtime";
import type { RequestScope } from "./runtime";
import { TURNSTILE_RESPONSE_FIELD } from "./turnstile";

interface CodeUseResult {
  readonly personId: PersonId | null;
}

const stringValue = Schema.decodeUnknownOption(Schema.String);

const scopeFor = (
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext
): RequestScope => ({
  ctx,
  env,
  headers: request.headers,
  signal: request.signal,
  testActor: undefined,
});

const successRedirect = (location: string, headers?: Headers): Response => {
  const responseHeaders = new Headers({ Location: location });

  for (const cookie of headers?.getSetCookie() ?? []) {
    responseHeaders.append("set-cookie", cookie);
  }

  return new Response(null, { headers: responseHeaders, status: 303 });
};

const codeFailure = (outcome: Failure): Response =>
  Predicate.isTagged(outcome.error, "Forbidden") ||
  Predicate.isTagged(outcome.error, "Conflict")
    ? wrongPasswordResponse()
    : Response.json({ message: outcome.message }, { status: outcome.status });

const codeCommand = (
  purpose: "activation" | "resetPassword",
  input: ReturnType<typeof ChoosePasswordForm.read>
) => {
  const noPerson: CodeUseResult = { personId: null };

  return purpose === "activation"
    ? Effect.map(
        AccountEndpoints.activateAccount(input),
        (account): CodeUseResult => ({ personId: account.personId })
      )
    : Effect.as(AccountEndpoints.resetPassword(input), noPerson);
};

const requestReset = (
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* resetRequest() {
      const form = yield* Effect.promise(() => request.formData());

      const token = Option.getOrNull(
        stringValue(form.get(TURNSTILE_RESPONSE_FIELD))
      );

      const outcome = yield* Effect.promise(() =>
        runPreparedCommand(
          scopeFor(request, env, ctx),
          prepareHuman({
            captchaToken: token,
            remoteIp: request.headers.get("CF-Connecting-IP"),
          }),
          () =>
            AccountEndpoints.requestPasswordReset(RequestResetForm.read(form))
        )
      );

      return Predicate.isTagged(outcome, "Success")
        ? successRedirect("/glemt-passord?sendt=1")
        : Response.json(
            { message: outcome.message },
            { status: outcome.status }
          );
    })
  );

const useCode = (
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  purpose: "activation" | "resetPassword"
): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* useCodeRequest() {
      const form = yield* Effect.promise(() => request.formData());
      const scope = scopeFor(request, env, ctx);
      const input = ChoosePasswordForm.read(form);
      const { password } = input;

      const command = codeCommand(purpose, input);

      const outcome = yield* Effect.promise(() =>
        runCommandOutcome(
          liveRequestLayer(scope),
          Effect.void,
          () => command,
          request.signal
        )
      );

      if (Predicate.isTagged(outcome, "Failure")) {
        return codeFailure(outcome);
      }

      const { enqueued, value } = outcome.value;

      const receipts = yield* Effect.promise(() =>
        runDeliveryChecked(env, enqueued, request.signal)
      );

      if (
        receipts.length !== enqueued.length ||
        Arr.some(
          receipts,
          (receipt) => !Predicate.isTagged(receipt, "Delivered")
        )
      ) {
        return Response.json(
          {
            message: "Endringen kunne ikke fullføres ennå. Prøv igjen senere.",
          },
          { status: 503 }
        );
      }

      if (purpose === "resetPassword") {
        return successRedirect("/logg-inn?passord-endret=1");
      }

      const { personId } = value;

      if (!Schema.is(Schema.String)(password) || personId === null) {
        return yield* Effect.die(
          "activation result did not include a validated password and account"
        );
      }

      const response = yield* Effect.promise(() =>
        runSignInPerson(
          env,
          { headers: request.headers, password, personId },
          request.signal
        )
      );

      return response.ok
        ? successRedirect("/etter-innlogging", response.headers)
        : response;
    })
  );

export const handleAccountPost = (
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  action: "activate" | "request-reset" | "reset-password"
): Promise<Response> => {
  if (request.method !== "POST") {
    return Promise.resolve(new Response("Method Not Allowed", { status: 405 }));
  }

  if (action === "request-reset") {
    return requestReset(request, env, ctx);
  }

  return useCode(
    request,
    env,
    ctx,
    action === "activate" ? "activation" : "resetPassword"
  );
};
