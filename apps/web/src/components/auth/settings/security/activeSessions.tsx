/** Adapted from better-auth-ui's base-nova ActiveSessions card (MIT). */
import { useListSessions, useRevokeSession } from "@better-auth-ui/react";
import { useRouter } from "@tanstack/react-router";
import { Array as Arr, Option } from "effect";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/lib/authClient";
import type { SessionClient } from "@/lib/sessionClient";

export interface SessionView extends SessionClient {
  readonly id: string;
  readonly createdAt: string;
  readonly lastSeen: string;
}

export const ActiveSessions = ({
  sessions,
  currentSessionId,
}: {
  readonly sessions: readonly SessionView[];
  readonly currentSessionId: string | null;
}) => {
  const router = useRouter();
  const listed = useListSessions(authClient);

  const revoke = useRevokeSession(authClient, {
    onSuccess: () => {
      void listed.refetch();
      void router.invalidate();
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Økter</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4">
          {sessions.length === 0 && <p>Ingen aktive økter.</p>}
          <ul aria-label="Aktive økter" className="grid gap-4">
            {Arr.map(sessions, (session) => {
              const authSession = Arr.findFirst(
                listed.data ?? [],
                (entry) => entry.id === session.id
              );

              return (
                <li
                  className="flex flex-wrap items-center justify-between gap-3 border-b pb-3"
                  key={session.id}
                >
                  <div>
                    <p>
                      {session.browser}, {session.system} ({session.device})
                    </p>
                    <p>Opprettet: {session.createdAt}</p>
                    <p>Sist sett: {session.lastSeen}</p>
                    {session.id === currentSessionId && <p>Denne økten</p>}
                  </div>
                  <Button
                    disabled={Option.isNone(authSession) || revoke.isPending}
                    onClick={() => {
                      if (Option.isSome(authSession)) {
                        revoke.mutate(
                          { token: authSession.value.token },
                          {
                            onSuccess: () => {
                              if (session.id === currentSessionId) {
                                void router.navigate({ to: "/logg-inn" });
                              }
                            },
                          }
                        );
                      }
                    }}
                    type="button"
                    variant="outline"
                  >
                    Avslutt økt
                  </Button>
                </li>
              );
            })}
          </ul>
          {revoke.isError && <p role="alert">Kunne ikke avslutte økten.</p>}
        </div>
      </CardContent>
    </Card>
  );
};
