import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import type { FieldComponent } from "@/components/form/field";
import { PageHeader } from "@/components/panel/pageHeader";
import { CommandSheet, InspectSheet } from "@/components/panel/panelSheets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { DepartmentForm } from "@/forms/department";
import { getDepartments, saveDepartment } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";
import type { DepartmentRow } from "@/server/panel";

type DepartmentFieldComponent = FieldComponent<
  typeof DepartmentForm.schema.Encoded
>;

/** What the department form holds when it opens for a new department: active, and nothing else. */
const NEW_DEPARTMENT: typeof DepartmentForm.schema.Encoded = {
  active: "on",
  address: "",
  city: "",
  email: "",
  id: "",
  latitude: "",
  logoKey: "",
  longitude: "",
  name: "",
  shortName: "",
  slackChannel: "",
};

/** What the department form holds when it opens on a stored department: every stored value. */
const departmentValues = (
  department: DepartmentRow
): typeof DepartmentForm.schema.Encoded => ({
  active: department.active ? "on" : undefined,
  address: department.address ?? "",
  city: department.city,
  email: department.email,
  id: String(department.id),
  latitude: String(department.latitude ?? ""),
  logoKey: department.logoKey ?? "",
  longitude: String(department.longitude ?? ""),
  name: department.name,
  shortName: department.shortName,
  slackChannel: department.slackChannel ?? "",
});

/**
 * The department form, for create and for edit. An edit carries every stored field (the id, the
 * coordinates, the logo key) as values of the form, so saving never blanks one the form does not show.
 */
const DepartmentFields = ({ Field }: { Field: DepartmentFieldComponent }) => (
  <>
    <Field name="name" label="Navn">
      <Input />
    </Field>
    <Field name="shortName" label="Kortnavn">
      <Input />
    </Field>
    <Field name="email" label="E-post">
      <Input type="email" />
    </Field>
    <Field name="city" label="By">
      <Input />
    </Field>
    <Field name="address" label="Adresse">
      <Input />
    </Field>
    <Field name="slackChannel" label="Slack-kanal (#kanal)">
      <Input />
    </Field>
    <div className="grid grid-cols-2 gap-3">
      <Field name="latitude" label="Breddegrad">
        <Input inputMode="decimal" />
      </Field>
      <Field name="longitude" label="Lengdegrad">
        <Input inputMode="decimal" />
      </Field>
    </div>
    <Field name="active" label="Aktiv">
      <Switch />
    </Field>
  </>
);

/** A department's stored details, read only. */
const DepartmentDetails = ({ department }: { department: DepartmentRow }) => (
  <dl className="grid gap-3 text-sm">
    {Arr.map(
      [
        ["Navn", department.name],
        ["Kortnavn", department.shortName],
        ["By", department.city],
        ["E-post", department.email],
        ["Adresse", department.address ?? "–"],
        ["Slack-kanal", department.slackChannel ?? "–"],
        [
          "Posisjon",
          department.latitude === null || department.longitude === null
            ? "–"
            : `${department.latitude}, ${department.longitude}`,
        ],
        ["Status", department.active ? "Aktiv" : "Inaktiv"],
      ] as const,
      ([label, value]) => (
        <div key={label} className="grid gap-0.5">
          <dt className="text-muted-foreground">{label}</dt>
          <dd>{value}</dd>
        </div>
      )
    )}
  </dl>
);

/** The row's one action: the edit form for an actor who may edit the department, its details for everyone else. */
const DepartmentRowAction = ({ department }: { department: DepartmentRow }) =>
  department.canEdit ? (
    <CommandSheet
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
      schema={DepartmentForm.schema}
      defaults={departmentValues(department)}
      submitLabel="Lagre"
    >
      {(Field) => <DepartmentFields Field={Field} />}
    </CommandSheet>
  ) : (
    <InspectSheet
      trigger={
        <Button
          variant="outline"
          size="sm"
          aria-label={`Vis ${department.name}`}
        />
      }
      triggerLabel="Vis"
      title={department.name}
      description="Du kan se avdelingen, men ikke endre den."
    >
      <DepartmentDetails department={department} />
    </InspectSheet>
  );

const routeApi = getRouteApi("/kontrollpanel/avdelinger");

const DepartmentsPage = () => {
  const { canCreate, departments } = routeApi.useLoaderData();

  return (
    <>
      <PageHeader
        title="Avdelinger"
        description="Hver by har én avdeling. Inaktive avdelinger vises også."
        actions={
          canCreate && (
            <CommandSheet
              trigger={<Button size="sm" />}
              triggerLabel="Ny avdeling"
              title="Ny avdeling"
              description="By må være unik."
              action={saveDepartment}
              schema={DepartmentForm.schema}
              defaults={NEW_DEPARTMENT}
              submitLabel="Opprett"
            >
              {(Field) => <DepartmentFields Field={Field} />}
            </CommandSheet>
          )
        }
      />
      <Card>
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
              {Arr.map(departments, (department) => (
                <TableRow key={department.id}>
                  <TableCell>
                    <span className="font-medium">{department.name}</span>
                  </TableCell>
                  <TableCell>{department.shortName}</TableCell>
                  <TableCell>{department.city}</TableCell>
                  <TableCell>{department.email}</TableCell>
                  <TableCell>
                    <Badge
                      variant={department.active ? "default" : "secondary"}
                    >
                      {department.active ? "Aktiv" : "Inaktiv"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <DepartmentRowAction department={department} />
                  </TableCell>
                </TableRow>
              ))}
              {departments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>Ingen avdelinger ennå.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
};

/** C1 departments: an admin creates; an admin or the department's team leader edits. City is unique. */
export const Route = createFileRoute("/kontrollpanel/avdelinger")({
  component: DepartmentsPage,
  loader: () => getDepartments().then(pageData),
});
