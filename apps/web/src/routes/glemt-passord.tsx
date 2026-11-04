import { Turnstile } from "@marsidev/react-turnstile";
import {
  createFileRoute,
  getRouteApi,
  useHydrated,
} from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getResetSiteKey } from "@/functions/account.functions";
import { authRequest } from "@/lib/authClient";
import { text } from "@/lib/formText";

const routeApi = getRouteApi("/glemt-passord");

const ForgotPassword = () => {
  const siteKey = routeApi.useLoaderData();
  const hydrated = useHydrated();

  const [state, setState] = useState<"idle" | "pending" | "done" | "error">(
    "idle"
  );

  return (
    <main className="mx-auto grid min-h-svh max-w-md content-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Glemt passord</CardTitle>
        </CardHeader>
        <CardContent>
          {state === "done" ? (
            <p role="status">Hvis en konto finnes, har vi sendt en lenke.</p>
          ) : (
            <form
              method="post"
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);

                setState("pending");
                void authRequest("request-reset", {
                  captchaToken: text(data, "cf-turnstile-response"),
                  email: text(data, "email"),
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
              <label className="grid gap-1" htmlFor="email">
                Privat e-post
                <Input
                  autoComplete="email"
                  id="email"
                  name="email"
                  required
                  type="email"
                />
              </label>
              <Turnstile siteKey={siteKey} />
              {state === "error" && (
                <p role="alert">Kunne ikke sende lenken. Prøv igjen.</p>
              )}
              <Button disabled={!hydrated || state === "pending"} type="submit">
                Send lenke
              </Button>
            </form>
          )}
          <a href="/logg-inn">Tilbake til innlogging</a>
        </CardContent>
      </Card>
    </main>
  );
};

export const Route = createFileRoute("/glemt-passord")({
  component: ForgotPassword,
  loader: () => getResetSiteKey(),
});
