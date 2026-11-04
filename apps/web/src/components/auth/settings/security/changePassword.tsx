import { useHydrated } from "@tanstack/react-router";
import { passwordAllowed } from "@vektorprogrammet/domain";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authRequest } from "@/lib/authClient";
import { text } from "@/lib/formText";

export const ChangePassword = () => {
  const hydrated = useHydrated();
  const [invalid, setInvalid] = useState(false);

  const [state, setState] = useState<"idle" | "pending" | "done" | "error">(
    "idle"
  );

  const submit: React.ComponentProps<"form">["onSubmit"] = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = text(form, "newPassword");
    setInvalid(!passwordAllowed(newPassword));

    if (!passwordAllowed(newPassword)) {
      return;
    }

    setState("pending");
    void authRequest("change-password", {
      currentPassword: text(form, "currentPassword"),
      newPassword,
    }).then(
      () => {
        setState("done");
      },
      () => {
        setState("error");
      }
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Endre passord</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" method="post" onSubmit={submit}>
          <label className="grid gap-1" htmlFor="currentPassword">
            Nåværende passord
            <Input
              autoComplete="current-password"
              id="currentPassword"
              name="currentPassword"
              required
              type="password"
            />
          </label>
          <label className="grid gap-1" htmlFor="newPassword">
            Nytt passord
            <Input
              autoComplete="new-password"
              id="newPassword"
              name="newPassword"
              required
              type="password"
            />
          </label>
          <p>Bruk 8–64 tegn og høyst 72 UTF-8-byte. Andre økter avsluttes.</p>
          {invalid && <p role="alert">Passordet oppfyller ikke kravene.</p>}
          {state === "error" && (
            <p role="alert">
              Kunne ikke fullføre endringen. Kontroller passord og økter.
            </p>
          )}
          {state === "done" && <p role="status">Passordet er endret.</p>}
          <Button disabled={!hydrated || state === "pending"} type="submit">
            Endre passord
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};
