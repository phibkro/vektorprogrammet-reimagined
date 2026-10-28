import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import type { WorkspacePlan } from "@vektorprogrammet/domain";
import { Array as Arr, Match } from "effect";

import { PageHeader } from "@/components/panel/pageHeader";
import { CommandSheet } from "@/components/panel/panelSheets";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getIntegrations,
  requestWorkspaceReport,
} from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/integrasjoner");

const issueText = (issue: WorkspacePlan.Issue): string =>
  Match.value(issue).pipe(
    Match.tagsExhaustive({
      ActualStateUnavailable: ({ reason }) =>
        `Google Workspace kunne ikke leses: ${reason}`,
      IncompleteGroupMembers: ({ teamId }) =>
        `Medlemslisten for team ${teamId} kan ikke sammenlignes før alle har gyldig adresse.`,
      InvalidCompanyAddress: ({ personId }) =>
        `Person ${personId} har en ugyldig Vektor-epost. Adressen må rettes før synkronisering.`,
      NoCompanyAddress: ({ personId }) =>
        `Person ${personId} mangler en gyldig bedriftsadresse.`,
      NoGroupAddress: ({ teamId }) =>
        `Team ${teamId} mangler en gruppeadresse.`,
      RemovalCapExceeded: ({ cap, removals }) =>
        `${removals} fjerninger overstiger grensen på ${cap}. Ingen endringer er lagt i kø.`,
    })
  );

const Addresses = ({ values }: { readonly values: readonly string[] }) =>
  values.length === 0 ? (
    <span>Ingen</span>
  ) : (
    <ul>
      {Arr.map(values, (address) => (
        <li key={address}>{address}</li>
      ))}
    </ul>
  );

const actualGroup = (group: WorkspacePlan.GroupLine) => {
  if (group.missing) {
    return <span>Mangler</span>;
  }

  if (group.actual === null) {
    return <span>Ukjent</span>;
  }

  return (
    <Addresses
      values={[
        ...Arr.filter(
          group.desired,
          (address) => !group.additions.includes(address)
        ),
        ...group.removals,
      ]}
    />
  );
};

const accountStatus = (present: boolean | null): string => {
  if (present === null) {
    return "Ukjent";
  }

  return present ? "Finnes" : "Mangler";
};

/** What each state of an undelivered message says to an administrator (spec 0008b). */
const DELIVERY_STATE_TEXT = {
  failed: "Mislyktes",
  queued: "I kø",
  retrying: "Prøver igjen",
  waiting: "Venter på kø",
} as const;

const IntegrationsPage = () => {
  const { mode, outbox, report } = routeApi.useLoaderData();

  return (
    <>
      <PageHeader
        title="Integrasjoner"
        description="Sammenlign ønsket Google Workspace med katalogen før endringer godkjennes."
        actions={
          <CommandSheet
            trigger={<Button size="sm" />}
            triggerLabel="Bestill prøverapport"
            title="Bestill prøverapport"
            description="En prøverapport endrer ikke Google Workspace, selv om skrivemodus er aktiv. Jobben tar bestillingen ved neste planlagte kjøring."
            action={requestWorkspaceReport}
            submitLabel="Bestill rapport"
          >
            <p>Rapporten viser forskjellene uten å gjøre endringer.</p>
          </CommandSheet>
        }
      />
      <p>
        Skrivemodus: <Badge>{mode === "write" ? "På" : "Av"}</Badge>
      </p>
      <Card>
        <CardContent>
          <h2 className="text-lg font-semibold">Utsendelser</h2>
          <p>
            Levert: {outbox.counts.delivered} · Venter: {outbox.counts.pending}{" "}
            · Mislyktes: {outbox.counts.failed}
          </p>
          {outbox.open.length === 0 ? (
            <p>Alle meldinger er levert.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Melding</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Forsøk</TableHead>
                  <TableHead>Neste forsøk</TableHead>
                  <TableHead>Siste feil</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Arr.map(outbox.open, (row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.id}</TableCell>
                    <TableCell>{row.kind}</TableCell>
                    <TableCell>{DELIVERY_STATE_TEXT[row.state]}</TableCell>
                    <TableCell>{row.attempts}</TableCell>
                    <TableCell>
                      {row.state === "failed" ? "–" : row.nextAttemptAt}
                    </TableCell>
                    <TableCell>{row.lastError ?? "–"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {report === null ? (
        <Alert>
          <AlertTitle>Ingen rapport ennå</AlertTitle>
          <AlertDescription>
            Bestill en prøverapport og vent på neste kjøring.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <Card>
            <CardContent>
              <h2 className="text-lg font-semibold">Siste rapport</h2>
              <p>
                Status: {report.status} · Modus: {report.mode} · Startet:{" "}
                {report.startedAt}
              </p>
              <p>
                Kontoer: {report.counts.accountsWanted ?? 0} ønsket,{" "}
                {report.counts.accountsToCreate ?? 0} å opprette. Grupper:{" "}
                {report.counts.groups ?? 0}. Tillegg:{" "}
                {report.counts.additions ?? 0}. Fjerninger:{" "}
                {report.counts.removals ?? 0}.
              </p>
              {report.actual === "unavailable" && (
                <p>
                  Katalogen er ikke tilgjengelig. Faktisk tilstand og
                  forskjeller er ikke kjent.
                </p>
              )}
            </CardContent>
          </Card>
          {report.issues.length > 0 && (
            <Alert>
              <AlertTitle>Forhold som må avklares</AlertTitle>
              <AlertDescription>
                <ul>
                  {Arr.map(report.issues, (issue, index) => (
                    <li key={index}>{issueText(issue)}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          <Card>
            <CardContent>
              <h2 className="text-lg font-semibold">Grupper</h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Gruppe</TableHead>
                    <TableHead>Ønsket</TableHead>
                    <TableHead>Faktisk</TableHead>
                    <TableHead>Legg til</TableHead>
                    <TableHead>Fjern</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Arr.map(report.groups, (group) => (
                    <TableRow key={group.teamId}>
                      <TableCell>
                        {group.name}
                        <br />
                        {group.address}
                      </TableCell>
                      <TableCell>
                        <Addresses values={group.desired} />
                      </TableCell>
                      <TableCell>{actualGroup(group)}</TableCell>
                      <TableCell>
                        <Addresses values={group.additions} />
                      </TableCell>
                      <TableCell>
                        <Addresses values={group.removals} />
                      </TableCell>
                    </TableRow>
                  ))}
                  {report.groups.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5}>
                        Ingen grupper i rapporten.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <h2 className="text-lg font-semibold">Kontoer</h2>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Person</TableHead>
                    <TableHead>Ønsket adresse</TableHead>
                    <TableHead>Faktisk</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Arr.map(report.accounts, (account) => (
                    <TableRow key={account.personId}>
                      <TableCell>{account.name}</TableCell>
                      <TableCell>{account.address}</TableCell>
                      <TableCell>{accountStatus(account.present)}</TableCell>
                    </TableRow>
                  ))}
                  {report.accounts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3}>
                        Ingen kontoer i rapporten.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <h2 className="text-lg font-semibold">Ønskede avdelingslister</h2>
              <p>
                Listen viser aktive teammedlemmer én gang per avdeling.
                Gruppeadresser for avdelingslistene er ikke konfigurert, så
                ingen endring i Google er beregnet.
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Avdeling</TableHead>
                    <TableHead>Medlemmer</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Arr.map(report.departmentLists, (list) => (
                    <TableRow key={list.departmentId}>
                      <TableCell>{list.name}</TableCell>
                      <TableCell>
                        <ul>
                          {Arr.map(list.members, (member) => (
                            <li key={member.personId}>
                              {member.name}: {member.address}
                            </li>
                          ))}
                        </ul>
                        {list.members.length === 0 && "Ingen"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <h2 className="text-lg font-semibold">
                Uadministrerte oppføringer
              </h2>
              <p>Disse blir rapportert, ikke fjernet.</p>
              <h3>Kontoer</h3>
              <Addresses values={report.unmanaged.accounts} />
              <h3>Grupper</h3>
              <Addresses values={report.unmanaged.groups} />
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
};

export const Route = createFileRoute("/kontrollpanel/integrasjoner")({
  component: IntegrationsPage,
  loader: () => getIntegrations().then(pageData),
});
