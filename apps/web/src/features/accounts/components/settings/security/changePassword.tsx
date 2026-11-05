import { useHydrated } from "@tanstack/react-router";
import { useState } from "react";

import { LocalForm } from "../../../../../components/form/localForm";
import { Button } from "../../../../../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../../../components/ui/card";
import { Input } from "../../../../../components/ui/input";
import { authRequest } from "../../../client";
import { ChangePasswordForm } from "../../../forms/account";

export const ChangePassword = () => {
  const hydrated = useHydrated();

  const [state, setState] = useState<"idle" | "pending" | "done" | "error">(
    "idle"
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Endre passord</CardTitle>
      </CardHeader>
      <CardContent>
        <LocalForm
          className="grid gap-4"
          defaults={{ currentPassword: "", newPassword: "" }}
          onValid={(values) => {
            const { currentPassword, newPassword } =
              ChangePasswordForm.payloadOf(values);

            setState("pending");
            void authRequest("change-password", {
              currentPassword,
              newPassword,
            }).then(
              () => {
                setState("done");
              },
              () => {
                setState("error");
              }
            );
          }}
          schema={ChangePasswordForm.schema}
        >
          {(Field) => (
            <>
              <Field label="Nåværende passord" name="currentPassword">
                <Input
                  autoComplete="current-password"
                  id="currentPassword"
                  type="password"
                />
              </Field>
              <Field label="Nytt passord" name="newPassword">
                <Input
                  autoComplete="new-password"
                  id="newPassword"
                  type="password"
                />
              </Field>
              <p>
                Bruk 8–64 tegn og høyst 72 UTF-8-byte. Andre økter avsluttes.
              </p>
              {state === "error" && (
                <p role="alert">
                  Kunne ikke fullføre endringen. Kontroller passord og økter.
                </p>
              )}
              {state === "done" && <p role="status">Passordet er endret.</p>}
              <Button disabled={!hydrated || state === "pending"} type="submit">
                Endre passord
              </Button>
            </>
          )}
        </LocalForm>
      </CardContent>
    </Card>
  );
};
