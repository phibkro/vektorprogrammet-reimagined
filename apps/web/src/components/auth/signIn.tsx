import { useHydrated, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authRequest } from "@/lib/authClient";
import { text } from "@/lib/formText";

export const SignIn = () => {
  const navigate = useNavigate();
  const hydrated = useHydrated();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit: React.ComponentProps<"form">["onSubmit"] = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailed(false);
    void authRequest("sign-in/email", {
      email: text(form, "email"),
      password: text(form, "password"),
    })
      .then(() => navigate({ to: "/etter-innlogging" }))
      .catch(() => {
        setFailed(true);
      })
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Logg inn</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" method="post" onSubmit={submit}>
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
          {failed && <p role="alert">Feil e-post eller passord.</p>}
          <Button disabled={!hydrated || pending} type="submit">
            Logg inn
          </Button>
          <a href="/glemt-passord">Glemt passord?</a>
        </form>
      </CardContent>
    </Card>
  );
};
