import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { Field, nativeSelectClass } from "@/components/forms";
import { PageHeader } from "@/components/panel/pageHeader";
import { CommandSheet } from "@/components/panel/panelSheets";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { getSocialEvents, saveSocialEvent } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/arrangementer");

const SocialEventsPage = () => {
  const {
    canCreate,
    events,
    departments,
    semesters,
    departmentId,
    currentSemesterId,
    currentSemesterLabel,
  } = routeApi.useLoaderData();

  return (
    <>
      <PageHeader
        title="Arrangementer"
        description="Avdelingens arrangementer dette semesteret."
        actions={
          canCreate && (
            <CommandSheet
              trigger={<Button size="sm" />}
              triggerLabel="Nytt arrangement"
              title="Nytt arrangement"
              action={saveSocialEvent}
              submitLabel="Opprett"
            >
              <Field name="title" label="Tittel">
                <Input name="title" />
              </Field>
              <Field name="description" label="Beskrivelse">
                <Textarea name="description" rows={4} />
              </Field>
              <Field name="startsAt" label="Start (norsk tid)">
                <Input name="startsAt" type="datetime-local" required />
              </Field>
              <Field name="endsAt" label="Slutt (norsk tid)">
                <Input name="endsAt" type="datetime-local" required />
              </Field>
              <Field name="link" label="Lenke">
                <Input name="link" maxLength={250} />
              </Field>
              <Field name="departmentId" label="Avdeling">
                <select
                  id="departmentId"
                  name="departmentId"
                  className={nativeSelectClass}
                  defaultValue={departmentId ?? undefined}
                >
                  {Arr.map(departments, (department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field name="semesterId" label="Semester">
                <select
                  id="semesterId"
                  name="semesterId"
                  className={nativeSelectClass}
                  defaultValue={currentSemesterId ?? undefined}
                >
                  {Arr.map(semesters, (semester) => (
                    <option key={semester.id} value={semester.id}>
                      {semester.label}
                    </option>
                  ))}
                </select>
              </Field>
            </CommandSheet>
          )
        }
      />
      {currentSemesterId === null && (
        <Alert>
          <AlertTitle>{currentSemesterLabel} er ikke opprettet ennå</AlertTitle>
          <AlertDescription>
            Semestre opprettes automatisk. Arrangementene i dette semesteret
            vises her så snart den planlagte jobben har kjørt.
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tittel</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Arr.map(events, (event) => (
                <TableRow key={event.id}>
                  <TableCell>
                    <span className="font-medium">{event.title}</span>
                  </TableCell>
                  <TableCell>{event.startsAt}</TableCell>
                  <TableCell>
                    {event.badge !== null && <Badge>{event.badge}</Badge>}
                  </TableCell>
                </TableRow>
              ))}
              {events.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3}>Ingen arrangementer ennå.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
};

/** C8 social events: title required, link ≤ 250, end after start (RULE-188); badges (RULE-085). */
export const Route = createFileRoute("/kontrollpanel/arrangementer")({
  component: SocialEventsPage,
  loader: () => getSocialEvents().then(pageData),
});
