import { useHydrated, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { LocalForm } from "@/components/form/localForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SignInForm } from "@/forms/account";
import { authRequest } from "@/lib/authClient";

export const SignIn = () => {
  const navigate = useNavigate();
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Logg inn</CardTitle>
      </CardHeader>
      <CardContent>
        <LocalForm
          className="grid gap-4"
          defaults={{ email: "", password: "", remember: undefined }}
          onValid={(values) => {
            const { email, password } = SignInForm.payloadOf(values);
            setPending(true);
            setFailed(false);
            void authRequest("sign-in/email", { email, password })
              .then(() => navigate({ to: "/etter-innlogging" }))
              .catch(() => {
                setFailed(true);
              })
              .finally(() => {
                setPending(false);
              });
          }}
          schema={SignInForm.schema}
        >
          {(Field) => (
            <>
              <Field label="E-post" name="email">
                <Input autoComplete="username" id="email" type="email" />
              </Field>
              <Field label="Passord" name="password">
                <Input
                  autoComplete="current-password"
                  id="password"
                  type="password"
                />
              </Field>
              {failed && <p role="alert">Feil e-post eller passord.</p>}
              <Button disabled={!hydrated || pending} type="submit">
                Logg inn
              </Button>
              <a href="/glemt-passord">Glemt passord?</a>
            </>
          )}
        </LocalForm>
      </CardContent>
    </Card>
  );
};
