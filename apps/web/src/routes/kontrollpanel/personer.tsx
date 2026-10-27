import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { Field, nativeSelectClass } from "@/components/forms";
import { PageHeader } from "@/components/panel/pageHeader";
import { CommandSheet } from "@/components/panel/panelSheets";
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
import { getPeople, registerPerson } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/personer");

const PeoplePage = () => {
  const { canRegister, fieldsOfStudy, people } = routeApi.useLoaderData();

  return (
    <>
      <PageHeader
        title="Personer"
        description="Personene i avdelingene dine. Avdelingen følger linjen personen studerer."
        actions={
          canRegister ? (
            <CommandSheet
              trigger={<Button size="sm" />}
              triggerLabel="Registrer person"
              title="Registrer person"
              description="Linjen bestemmer hvilken avdeling personen hører til."
              action={registerPerson}
              submitLabel="Registrer"
            >
              <Field name="name" label="Navn">
                <Input name="name" />
              </Field>
              <Field name="email" label="E-post">
                <Input name="email" type="email" />
              </Field>
              <Field name="fieldOfStudyId" label="Linje">
                <select name="fieldOfStudyId" className={nativeSelectClass}>
                  {Arr.map(fieldsOfStudy, (field) => (
                    <option key={field.id} value={field.id}>
                      {field.label}
                    </option>
                  ))}
                </select>
              </Field>
            </CommandSheet>
          ) : undefined
        }
      />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Navn</TableHead>
                <TableHead>E-post</TableHead>
                <TableHead>Avdeling</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Arr.map(people, (person) => (
                <TableRow key={person.id}>
                  <TableCell>
                    <span className="font-medium">{person.name}</span>
                  </TableCell>
                  <TableCell>{person.email}</TableCell>
                  <TableCell>{person.departmentName}</TableCell>
                </TableRow>
              ))}
              {people.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3}>Ingen personer å vise ennå.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
};

/** Spec 0006: people of the principal's departments; the register control is there only when `registerPerson` is granted. */
export const Route = createFileRoute("/kontrollpanel/personer")({
  component: PeoplePage,
  loader: () => getPeople().then(pageData),
});
