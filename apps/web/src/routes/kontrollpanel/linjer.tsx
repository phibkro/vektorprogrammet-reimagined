import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { Field } from "@/components/forms";
import { PageHeader } from "@/components/panel/pageHeader";
import { CommandSheet } from "@/components/panel/panelSheets";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  getFieldsOfStudy,
  saveFieldOfStudy,
} from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

interface FieldOfStudyRow {
  readonly id: number;
  readonly name: string;
  readonly shortName: string;
}

const FieldOfStudyFields = ({ field }: { field?: FieldOfStudyRow }) => (
  <>
    <Field name="name" label="Navn">
      <Input name="name" defaultValue={field?.name} />
    </Field>
    <Field name="shortName" label="Kortnavn">
      <Input name="shortName" defaultValue={field?.shortName} />
    </Field>
  </>
);

const routeApi = getRouteApi("/kontrollpanel/linjer");

const FieldsOfStudyPage = () => {
  const { canManage, department, fieldsOfStudy } = routeApi.useLoaderData();

  if (!canManage) {
    return (
      <Alert>
        <AlertTitle>Ingen tilgang</AlertTitle>
        <AlertDescription>
          Du har ikke tilgang til å administrere linjer.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      <PageHeader
        title="Linjer"
        description={`${department.name}. Du administrerer bare linjene i din egen avdeling.`}
        actions={
          <CommandSheet
            trigger={<Button size="sm" />}
            triggerLabel="Ny linje"
            title="Ny linje"
            description={`Linjen opprettes i ${department.name}.`}
            action={saveFieldOfStudy}
            submitLabel="Opprett"
          >
            <input type="hidden" name="departmentId" value={department.id} />
            <FieldOfStudyFields />
          </CommandSheet>
        }
      />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Navn</TableHead>
                <TableHead>Kortnavn</TableHead>
                <TableHead>
                  <span className="sr-only">Handlinger</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Arr.map(fieldsOfStudy, (field) => (
                <TableRow key={field.id}>
                  <TableCell>
                    <span className="font-medium">{field.name}</span>
                  </TableCell>
                  <TableCell>{field.shortName}</TableCell>
                  <TableCell className="text-right">
                    <CommandSheet
                      trigger={
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Gi nytt navn til ${field.name}`}
                        />
                      }
                      triggerLabel="Gi nytt navn"
                      title={`Gi nytt navn til ${field.name}`}
                      action={saveFieldOfStudy}
                      submitLabel="Lagre"
                    >
                      <input type="hidden" name="id" value={field.id} />
                      <FieldOfStudyFields field={field} />
                    </CommandSheet>
                  </TableCell>
                </TableRow>
              ))}
              {fieldsOfStudy.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3}>
                    Ingen linjer i denne avdelingen ennå.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
};

/** C1 fields of study of the actor's own department only (RULE-139). */
export const Route = createFileRoute("/kontrollpanel/linjer")({
  component: FieldsOfStudyPage,
  loader: () => getFieldsOfStudy().then(pageData),
});
