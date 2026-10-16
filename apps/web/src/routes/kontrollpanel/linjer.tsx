import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr, pipe } from "effect";

import { CommandDialog } from "@/components/commandDialog";
import { Field } from "@/components/forms";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  const { department, fieldsOfStudy } = routeApi.useLoaderData();

  if (department === null) {
    return (
      <Alert>
        <AlertTitle>Ikke innlogget</AlertTitle>
        <AlertDescription>
          Du må være innlogget som ansatt for å administrere linjer.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Linjer</h1>
      <Card>
        <CardHeader>
          <CardTitle>{department.name}</CardTitle>
          <CardDescription>
            Du administrerer bare linjene i din egen avdeling.
          </CardDescription>
          <CardAction>
            <CommandDialog
              trigger={<Button size="sm" />}
              triggerLabel="Ny linje"
              title="Ny linje"
              description={`Linjen opprettes i ${department.name}.`}
              action={saveFieldOfStudy}
              submitLabel="Opprett"
            >
              <input type="hidden" name="departmentId" value={department.id} />
              <FieldOfStudyFields />
            </CommandDialog>
          </CardAction>
        </CardHeader>
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
              {pipe(
                fieldsOfStudy,
                Arr.map((field) => (
                  <TableRow key={field.id}>
                    <TableCell>
                      <span className="font-medium">{field.name}</span>
                    </TableCell>
                    <TableCell>{field.shortName}</TableCell>
                    <TableCell className="text-right">
                      <CommandDialog
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
                      </CommandDialog>
                    </TableCell>
                  </TableRow>
                ))
              )}
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
    </section>
  );
};

/** C1 fields of study of the actor's own department only (RULE-139). */
export const Route = createFileRoute("/kontrollpanel/linjer")({
  component: FieldsOfStudyPage,
  loader: () => getFieldsOfStudy().then(pageData),
});
