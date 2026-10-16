import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr, pipe } from "effect";

import { CommandDialog } from "@/components/commandDialog";
import { Field } from "@/components/forms";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getDepartments, saveDepartment } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";
import type { DepartmentRow } from "@/server/panel";

/**
 * The department form, for create and for edit. An edit carries every stored field (the id, the
 * coordinates, the logo key), so saving never blanks one the form does not show.
 */
const DepartmentFields = ({ department }: { department?: DepartmentRow }) => (
  <>
    {department !== undefined && (
      <>
        <input type="hidden" name="id" value={department.id} />
        <input type="hidden" name="logoKey" value={department.logoKey ?? ""} />
      </>
    )}
    <Field name="name" label="Navn">
      <Input name="name" defaultValue={department?.name} />
    </Field>
    <Field name="shortName" label="Kortnavn">
      <Input name="shortName" defaultValue={department?.shortName} />
    </Field>
    <Field name="email" label="E-post">
      <Input name="email" type="email" defaultValue={department?.email} />
    </Field>
    <Field name="city" label="By">
      <Input name="city" defaultValue={department?.city} />
    </Field>
    <Field name="address" label="Adresse">
      <Input name="address" defaultValue={department?.address ?? ""} />
    </Field>
    <Field name="slackChannel" label="Slack-kanal (#kanal)">
      <Input
        name="slackChannel"
        defaultValue={department?.slackChannel ?? ""}
      />
    </Field>
    <div className="grid grid-cols-2 gap-3">
      <Field name="latitude" label="Breddegrad">
        <Input
          name="latitude"
          inputMode="decimal"
          defaultValue={department?.latitude ?? ""}
        />
      </Field>
      <Field name="longitude" label="Lengdegrad">
        <Input
          name="longitude"
          inputMode="decimal"
          defaultValue={department?.longitude ?? ""}
        />
      </Field>
    </div>
    <label className="flex items-center gap-2 text-sm font-medium">
      <Switch name="active" defaultChecked={department?.active ?? true} />
      Aktiv
    </label>
  </>
);

const DepartmentRowView = ({ department }: { department: DepartmentRow }) => (
  <TableRow>
    <TableCell>
      <span className="font-medium">{department.name}</span>
    </TableCell>
    <TableCell>{department.shortName}</TableCell>
    <TableCell>{department.city}</TableCell>
    <TableCell>{department.email}</TableCell>
    <TableCell>
      <Badge variant={department.active ? "default" : "secondary"}>
        {department.active ? "Aktiv" : "Inaktiv"}
      </Badge>
    </TableCell>
    <TableCell className="text-right">
      <CommandDialog
        trigger={
          <Button
            variant="outline"
            size="sm"
            aria-label={`Rediger ${department.name}`}
          />
        }
        triggerLabel="Rediger"
        title={`Rediger ${department.name}`}
        action={saveDepartment}
        submitLabel="Lagre"
      >
        <DepartmentFields department={department} />
      </CommandDialog>
    </TableCell>
  </TableRow>
);

const routeApi = getRouteApi("/kontrollpanel/avdelinger");

const DepartmentsPage = () => {
  const { actor, departments } = routeApi.useLoaderData();

  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Avdelinger</h1>
      <Card>
        <CardHeader>
          <CardTitle>Alle avdelinger</CardTitle>
          <CardDescription>
            Hver by har én avdeling. Inaktive avdelinger vises også.
          </CardDescription>
          {actor?.role === "admin" && (
            <CardAction>
              <CommandDialog
                trigger={<Button size="sm" />}
                triggerLabel="Ny avdeling"
                title="Ny avdeling"
                description="By må være unik."
                action={saveDepartment}
                submitLabel="Opprett"
              >
                <DepartmentFields />
              </CommandDialog>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Navn</TableHead>
                <TableHead>Kortnavn</TableHead>
                <TableHead>By</TableHead>
                <TableHead>E-post</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>
                  <span className="sr-only">Handlinger</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pipe(
                departments,
                Arr.map((department) => (
                  <DepartmentRowView
                    key={department.id}
                    department={department}
                  />
                ))
              )}
              {departments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>Ingen avdelinger ennå.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  );
};

/** C1 departments: an admin creates; an admin or the department's team leader edits. City is unique. */
export const Route = createFileRoute("/kontrollpanel/avdelinger")({
  component: DepartmentsPage,
  loader: () => getDepartments().then(pageData),
});
