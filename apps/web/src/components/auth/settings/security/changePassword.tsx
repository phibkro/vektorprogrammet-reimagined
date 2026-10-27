/** Adapted from better-auth-ui's base-nova ChangePassword card (MIT). */
import { useChangePassword } from "@better-auth-ui/react";
import { passwordAllowed } from "@vektorprogrammet/domain";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/authClient";
import { text } from "@/lib/formText";

export const ChangePassword = () => {
  const [invalid, setInvalid] = useState(false);
  const change = useChangePassword(authClient);

  const submit = (event: {
    currentTarget: HTMLFormElement;
    preventDefault: () => void;
  }) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = text(form, "currentPassword");
    const newPassword = text(form, "newPassword");
    const valid = passwordAllowed(newPassword);
    setInvalid(!valid);

    if (valid) {
      change.mutate({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Endre passord</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
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
          {change.isError && <p role="alert">Kunne ikke endre passordet.</p>}
          {change.isSuccess && <p role="status">Passordet er endret.</p>}
          <Button disabled={change.isPending} type="submit">
            Endre passord
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};
