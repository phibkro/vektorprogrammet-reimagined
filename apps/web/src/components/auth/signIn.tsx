/** Adapted from better-auth-ui's base-nova sign-in registry component (MIT). */
import { useSignInEmail } from "@better-auth-ui/react";
import { useNavigate } from "@tanstack/react-router";

import { LocalForm } from "@/components/form/localForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SignInForm } from "@/forms/account";
import { authClient } from "@/lib/authClient";

export const SignIn = () => {
  const navigate = useNavigate();

  const signIn = useSignInEmail(authClient, {
    onSuccess: () => {
      void navigate({ to: "/etter-innlogging" });
    },
  });

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
            const { email, password, remember } = SignInForm.payloadOf(values);

            signIn.mutate({ email, password, rememberMe: remember });
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
              <Field label="Husk meg" name="remember">
                <Checkbox id="remember" />
              </Field>
              {signIn.isError && <p role="alert">Feil e-post eller passord.</p>}
              <Button disabled={signIn.isPending} type="submit">
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
