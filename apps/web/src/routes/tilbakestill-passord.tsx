import {
  createFileRoute,
  getRouteApi,
  useHydrated,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { authRequest } from "../features/accounts/client";
import { passwordAllowed } from "../features/accounts/domain/entities";
import { text } from "../utils/formText";

const Search = Schema.toStandardSchemaV1(
  Schema.Struct({ token_hash: Schema.optionalKey(Schema.String) })
);

const routeApi = getRouteApi("/tilbakestill-passord");

const ResetPage = () => {
  const { token_hash: tokenHash } = routeApi.useSearch();
  const hydrated = useHydrated();

  const [state, setState] = useState<"idle" | "pending" | "done" | "error">(
    "idle"
  );

  return (
    <main className="mx-auto grid min-h-svh max-w-md content-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Velg nytt passord</CardTitle>
        </CardHeader>
        <CardContent>
          {state === "done" && (
            <p role="status">
              Passordet er endret. <a href="/logg-inn">Logg inn</a>
            </p>
          )}
          {state !== "done" && tokenHash !== undefined && tokenHash !== "" && (
            <form
              method="post"
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();

                const password = text(
                  new FormData(event.currentTarget),
                  "password"
                );

                if (!passwordAllowed(password)) {
                  setState("error");

                  return;
                }

                setState("pending");
                void authRequest("reset-password", {
                  newPassword: password,
                  tokenHash,
                }).then(
                  () => {
                    setState("done");
                  },
                  () => {
                    setState("error");
                  }
                );
              }}
            >
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
              <p>Bruk 8–64 tegn og høyst 72 UTF-8-byte.</p>
              {state === "error" && (
                <p role="alert">
                  Lenken er ugyldig eller passordet oppfyller ikke kravene.
                </p>
              )}
              <Button disabled={!hydrated || state === "pending"} type="submit">
                Lagre passord
              </Button>
            </form>
          )}
          {state !== "done" &&
            (tokenHash === undefined || tokenHash === "") && (
              <p>Lenken mangler en kode.</p>
            )}
        </CardContent>
      </Card>
    </main>
  );
};

export const Route = createFileRoute("/tilbakestill-passord")({
  component: ResetPage,
  head: () => ({ meta: [{ content: "no-referrer", name: "referrer" }] }),
  headers: () => ({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  }),
  validateSearch: Search,
});
