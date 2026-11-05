import { createFileRoute } from "@tanstack/react-router";
import { Effect, Option, Predicate, Schema } from "effect";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requestScope } from "@/server/http/scope";
import { runCommand, runQuery } from "@/server/runtime";

import { createRequestClient } from "../adapters/supabase/clients";
import { PersonId } from "../domain/ids";
import { CurrentPrincipal, Principal } from "../domain/kernel/principal";
import { AccountEndpoints } from "../features/accounts/domain/commands";
import { passwordAllowed } from "../features/accounts/domain/entities";
import { AccountRepository } from "../features/accounts/domain/services";

const ActivatePage = () => (
  <main className="mx-auto grid min-h-svh max-w-md content-center px-4 py-12">
    <Card>
      <CardHeader>
        <CardTitle>Aktiver konto</CardTitle>
      </CardHeader>
      <CardContent>
        <form action="/aktiver" className="grid gap-4" method="post">
          <label className="grid gap-1" htmlFor="password">
            Nytt passord
            <Input
              autoComplete="new-password"
              id="password"
              name="password"
              required
              type="password"
            />
          </label>
          <Button type="submit">Aktiver konto</Button>
        </form>
      </CardContent>
    </Card>
  </main>
);

export const Route = createFileRoute("/aktiver")({
  component: ActivatePage,
  server: {
    handlers: {
      POST: ({ request, context }) =>
        Effect.runPromise(
          Effect.gen(function* activate() {
            const client = createRequestClient(context.env);

            const { data, error } = yield* Effect.promise(() =>
              client.auth.getUser()
            );

            const id = Schema.decodeUnknownOption(PersonId)(
              data.user?.app_metadata.personId
            );

            const verifiedEmail = data.user?.email;

            if (
              error !== null ||
              Option.isNone(id) ||
              verifiedEmail === undefined ||
              verifiedEmail === ""
            ) {
              return new Response("Invalid invitation", { status: 403 });
            }

            const account = yield* Effect.promise(() =>
              runQuery(
                requestScope(context),
                AccountRepository.use((repo) => repo.find(id.value))
              )
            );

            if (
              Predicate.isTagged(account, "Failure") ||
              !Option.exists(account.value, (value) =>
                Predicate.isTagged(value.state, "Invited")
              )
            ) {
              return new Response("Invalid invitation", { status: 403 });
            }

            const password = Schema.decodeUnknownOption(Schema.String)(
              (yield* Effect.promise(() => request.formData())).get("password")
            );

            if (Option.isNone(password) || !passwordAllowed(password.value)) {
              return new Response("Password required", { status: 400 });
            }

            const updated = yield* Effect.promise(() =>
              client.auth.updateUser({ password: password.value })
            );

            if (updated.error !== null) {
              return new Response("Password could not be saved", {
                status: 400,
              });
            }

            const principal = Principal.narrow(
              Principal.cases.Person.make({
                client: "browser",
                memberships: [],
                personId: id.value,
              }),
              {
                command: "activateAccount",
                resource: { personId: id.value },
              }
            );

            const result = yield* Effect.promise(() =>
              runCommand(
                requestScope(context),
                AccountEndpoints.activateAccount({
                  email: verifiedEmail,
                  personId: id.value,
                }).pipe(Effect.provideService(CurrentPrincipal, principal))
              )
            );

            if (Predicate.isTagged(result, "Failure")) {
              return new Response(result.message, { status: result.status });
            }

            return new Response(null, {
              headers: { Location: "/etter-innlogging" },
              status: 303,
            });
          })
        ),
    },
  },
});
