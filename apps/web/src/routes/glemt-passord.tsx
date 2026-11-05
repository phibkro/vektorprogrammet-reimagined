import { Turnstile } from "@marsidev/react-turnstile";
import {
  createFileRoute,
  getRouteApi,
  useHydrated,
} from "@tanstack/react-router";
import { useState } from "react";

import { LocalForm } from "@/components/form/localForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { authRequest } from "../features/accounts/client";
import { RequestResetForm } from "../features/accounts/forms/account";
import { getResetSiteKey } from "../features/accounts/server/functions";

const routeApi = getRouteApi("/glemt-passord");

const ForgotPassword = () => {
  const siteKey = routeApi.useLoaderData();
  const hydrated = useHydrated();
  const [captchaToken, setCaptchaToken] = useState("");

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
            <LocalForm
              className="grid gap-4"
              defaults={{ email: "" }}
              schema={RequestResetForm.schema}
              onValid={(values) => {
                const { email } = RequestResetForm.payloadOf(values);
                setState("pending");
                void authRequest("request-reset", { captchaToken, email }).then(
                  () => {
                    setState("done");
                  },
                  () => {
                    setState("error");
                  }
                );
              }}
            >
              {(Field) => (
                <>
                  <Field label="Privat e-post" name="email">
                    <Input autoComplete="email" id="email" type="email" />
                  </Field>
                  <Turnstile
                    siteKey={siteKey}
                    onSuccess={setCaptchaToken}
                    onExpire={() => {
                      setCaptchaToken("");
                    }}
                  />
                  {state === "error" && (
                    <p role="alert">Kunne ikke sende lenken. Prøv igjen.</p>
                  )}
                  <Button
                    disabled={!hydrated || state === "pending"}
                    type="submit"
                  >
                    Send lenke
                  </Button>
                </>
              )}
            </LocalForm>
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
