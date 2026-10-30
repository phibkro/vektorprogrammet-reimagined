import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { Choice, firstValue, optionsOf } from "@/components/form/choice";
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
import { SocialEventForm } from "@/forms/organisation";
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

  const departmentChoices = optionsOf(departments);

  const semesterChoices = Arr.map(semesters, (semester) => ({
    label: semester.label,
    value: String(semester.id),
  }));

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
              schema={SocialEventForm.schema}
              defaults={{
                departmentId: String(
                  departmentId ?? firstValue(departmentChoices)
                ),
                description: "",
                endsAt: "",
                link: "",
                semesterId: String(
                  currentSemesterId ?? firstValue(semesterChoices)
                ),
                startsAt: "",
                title: "",
              }}
              submitLabel="Opprett"
            >
              {(Field) => (
                <>
                  <Field name="title" label="Tittel">
                    <Input />
                  </Field>
                  <Field name="description" label="Beskrivelse">
                    <Textarea rows={4} />
                  </Field>
                  <Field name="startsAt" label="Start (norsk tid)">
                    <Input type="datetime-local" required />
                  </Field>
                  <Field name="endsAt" label="Slutt (norsk tid)">
                    <Input type="datetime-local" required />
                  </Field>
                  <Field name="link" label="Lenke">
                    <Input maxLength={250} />
                  </Field>
                  <Field name="departmentId" label="Avdeling">
                    <Choice id="departmentId" options={departmentChoices} />
                  </Field>
                  <Field name="semesterId" label="Semester">
                    <Choice id="semesterId" options={semesterChoices} />
                  </Field>
                </>
              )}
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
