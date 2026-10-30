import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { ApplicantFields } from "@/components/admission/applicantFields";
import { Choice, firstValue } from "@/components/form/choice";
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
import {
  CancelPeriodForm,
  ExtendPeriodForm,
  RegisterApplicationForm,
  SchedulePeriodForm,
  WithdrawApplicationForm,
} from "@/forms/admission";
import {
  cancelPeriod,
  extendPeriod,
  getAdmission,
  registerApplication,
  schedulePeriod,
  withdrawApplication,
} from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/opptak");

const STATE_LABEL = { Submitted: "Sendt inn", Withdrawn: "Trukket" } as const;

const OpptakPage = () => {
  const view = routeApi.useLoaderData();

  const departmentChoices = Arr.map(view.schedulable, (department) => ({
    label: department.name,
    value: String(department.id),
  }));

  return (
    <>
      <PageHeader
        title="Opptak"
        description="Opptaksperiodene og søknadene i avdelingene dine."
        actions={
          departmentChoices.length > 0 && (
            <CommandSheet
              trigger={<Button size="sm" />}
              triggerLabel="Nytt opptak"
              title="Nytt opptak"
              description="Én opptaksperiode per avdeling og semester. Tidene er norsk tid."
              action={schedulePeriod}
              schema={SchedulePeriodForm.schema}
              defaults={{
                departmentId: firstValue(departmentChoices),
                end: "",
                semester: firstValue(view.semesters),
                start: "",
              }}
              submitLabel="Opprett"
            >
              {(Field) => (
                <>
                  <Field name="departmentId" label="Avdeling">
                    <Choice options={departmentChoices} />
                  </Field>
                  <Field name="semester" label="Semester">
                    <Choice options={view.semesters} />
                  </Field>
                  <Field name="start" label="Start (norsk tid)">
                    <Input type="datetime-local" required />
                  </Field>
                  <Field name="end" label="Slutt (norsk tid)">
                    <Input type="datetime-local" required />
                  </Field>
                </>
              )}
            </CommandSheet>
          )
        }
      />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Avdeling</TableHead>
                <TableHead>Semester</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>Slutt</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>
                  <span className="sr-only">Handlinger</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Arr.map(view.periods, (period) => (
                <TableRow key={period.id}>
                  <TableCell>{period.departmentName}</TableCell>
                  <TableCell>{period.semester}</TableCell>
                  <TableCell>{period.start}</TableCell>
                  <TableCell>{period.end}</TableCell>
                  <TableCell>
                    <Badge>{period.stateLabel}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {period.canExtend && (
                        <CommandSheet
                          trigger={
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label={`Forleng opptaket i ${period.departmentName}, ${period.semester}`}
                            />
                          }
                          triggerLabel="Forleng"
                          title={`Forleng opptaket i ${period.departmentName}`}
                          description="Slutten flyttes senere. Starten endres ikke."
                          action={extendPeriod}
                          schema={ExtendPeriodForm.schema}
                          defaults={{ end: "", id: String(period.id) }}
                          submitLabel="Forleng"
                        >
                          {(Field) => (
                            <Field name="end" label="Ny slutt (norsk tid)">
                              <Input type="datetime-local" required />
                            </Field>
                          )}
                        </CommandSheet>
                      )}
                      {period.canCancel && (
                        <CommandSheet
                          trigger={
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label={`Avlys opptaket i ${period.departmentName}, ${period.semester}`}
                            />
                          }
                          triggerLabel="Avlys"
                          title={`Avlys opptaket i ${period.departmentName}`}
                          description="Opptaket har ikke begynt og har ingen søknader."
                          action={cancelPeriod}
                          schema={CancelPeriodForm.schema}
                          defaults={{ id: String(period.id) }}
                          submitLabel="Avlys opptaket"
                        />
                      )}
                      {period.register !== null && (
                        <CommandSheet
                          trigger={
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label={`Registrer søker i ${period.departmentName}, ${period.semester}`}
                            />
                          }
                          triggerLabel="Registrer søker"
                          title={`Registrer søker i ${period.departmentName}`}
                          description="For søkere du møter på stand. Samme felter som søknadsskjemaet."
                          action={registerApplication}
                          schema={RegisterApplicationForm.schema}
                          defaults={{ periodId: String(period.id) }}
                          submitLabel="Registrer"
                        >
                          {(Field) => (
                            <ApplicantFields
                              Field={Field}
                              options={{
                                answers: view.answers,
                                consent: view.consent,
                                fieldsOfStudy:
                                  period.register?.fieldsOfStudy ?? [],
                                teams: period.register?.teams ?? [],
                              }}
                            />
                          )}
                        </CommandSheet>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {view.periods.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>Ingen opptak ennå.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Søker</TableHead>
                <TableHead>E-post</TableHead>
                <TableHead>Avdeling</TableHead>
                <TableHead>Sendt inn</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>
                  <span className="sr-only">Handlinger</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Arr.map(view.applications, (application) => (
                <TableRow key={application.id}>
                  <TableCell>
                    <span className="font-medium">{application.name}</span>
                  </TableCell>
                  <TableCell>
                    {application.email}{" "}
                    {application.emailVerified ? (
                      <Badge>Bekreftet</Badge>
                    ) : (
                      <Badge variant="outline">Ikke bekreftet</Badge>
                    )}
                  </TableCell>
                  <TableCell>{application.departmentName}</TableCell>
                  <TableCell>{application.createdAt}</TableCell>
                  <TableCell>{STATE_LABEL[application.state]}</TableCell>
                  <TableCell className="text-right">
                    {application.canWithdraw && (
                      <CommandSheet
                        trigger={
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Trekk søknaden til ${application.name}`}
                          />
                        }
                        triggerLabel="Trekk søknad"
                        title={`Trekk søknaden til ${application.name}`}
                        description="Søknaden beholdes til opptakets oppbevaringstid er over, og slettes ikke for hånd."
                        action={withdrawApplication}
                        schema={WithdrawApplicationForm.schema}
                        defaults={{ id: String(application.id) }}
                        submitLabel="Trekk søknaden"
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {view.applications.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>Ingen søknader ennå.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {view.periods.length === 0 && view.schedulable.length === 0 && (
        <Alert>
          <AlertTitle>Ingen opptak</AlertTitle>
          <AlertDescription>
            Du har ikke tilgang til å opprette opptak.
          </AlertDescription>
        </Alert>
      )}
    </>
  );
};

/** Spec 0009: the admission periods and the applications of the departments that the actor may see (`viewAdmission`). */
export const Route = createFileRoute("/kontrollpanel/opptak")({
  component: OpptakPage,
  loader: () => getAdmission().then(pageData),
});
