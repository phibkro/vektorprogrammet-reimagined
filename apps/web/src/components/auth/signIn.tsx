/** Adapted from better-auth-ui's base-nova sign-in registry component (MIT). */
import { useSignInEmail } from "@better-auth-ui/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/authClient";
import { text } from "@/lib/formText";

export const SignIn = () => {
  const [remember, setRemember] = useState(false);
  const navigate = useNavigate();

  const signIn = useSignInEmail(authClient, {
    onSuccess: () => {
      void navigate({ to: "/etter-innlogging" });
    },
  });

  const submit = (event: {
    currentTarget: HTMLFormElement;
    preventDefault: () => void;
  }) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    signIn.mutate({
      email: text(form, "email"),
      password: text(form, "password"),
      rememberMe: remember,
    });
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Logg inn</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          <label className="grid gap-1" htmlFor="email">
            E-post
            <Input
              autoComplete="username"
              id="email"
              name="email"
              required
              type="email"
            />
          </label>
          <label className="grid gap-1" htmlFor="password">
            Passord
            <Input
              autoComplete="current-password"
              id="password"
              name="password"
              required
              type="password"
            />
          </label>
          <label className="flex items-center gap-2" htmlFor="remember">
            <Checkbox
              checked={remember}
              id="remember"
              onCheckedChange={setRemember}
            />{" "}
            Husk meg
          </label>
          {signIn.isError && <p role="alert">Feil e-post eller passord.</p>}
          <Button disabled={signIn.isPending} type="submit">
            Logg inn
          </Button>
          <a href="/glemt-passord">Glemt passord?</a>
        </form>
      </CardContent>
    </Card>
  );
};
