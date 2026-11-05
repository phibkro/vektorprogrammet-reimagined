import { useState } from "react";

import { Button } from "../../../../../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../../../components/ui/card";
import { authRequest } from "../../../client";

/** Supabase supports ending the other sessions as a group, not listing individual sessions. */
export const ActiveSessions = () => {
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">(
    "idle"
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Økter</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4">
          <p>
            Du kan avslutte alle andre økter. Individuelle økter vises ikke.
          </p>
          <Button
            disabled={state === "pending"}
            onClick={() => {
              setState("pending");
              void authRequest("revoke-other-sessions").then(
                () => {
                  setState("done");
                },
                () => {
                  setState("error");
                }
              );
            }}
            type="button"
            variant="outline"
          >
            Avslutt andre økter
          </Button>
          {state === "done" && (
            <p role="status">
              Andre økter er avsluttet. Tilgang kan vare til eksisterende
              tilgangstokener utløper.
            </p>
          )}
          {state === "error" && (
            <p role="alert">Kunne ikke avslutte andre økter.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
};
