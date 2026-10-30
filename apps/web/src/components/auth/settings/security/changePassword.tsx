/** Adapted from better-auth-ui's base-nova ChangePassword card (MIT). */
import { useChangePassword } from "@better-auth-ui/react";

import { LocalForm } from "@/components/form/localForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ChangePasswordForm } from "@/forms/account";
import { authClient } from "@/lib/authClient";

export const ChangePassword = () => {
  const change = useChangePassword(authClient);

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

            change.mutate({
              currentPassword,
              newPassword,
              revokeOtherSessions: true,
            });
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
              {change.isError && (
                <p role="alert">Kunne ikke endre passordet.</p>
              )}
              {change.isSuccess && <p role="status">Passordet er endret.</p>}
              <Button disabled={change.isPending} type="submit">
                Endre passord
              </Button>
            </>
          )}
        </LocalForm>
      </CardContent>
    </Card>
  );
};
