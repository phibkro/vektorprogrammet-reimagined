import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr, pipe } from "effect";

import { CommandForm, Field } from "@/components/forms";
import { Input } from "@/components/ui/input";
import { getDashboard, saveDepartment } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";
import type { DepartmentRow } from "@/server/panel";

const DepartmentFields = ({ department }: { department?: DepartmentRow }) => (
  <>
    {department !== undefined && (
      <input type="hidden" name="id" value={department.id} />
    )}
    <Field name="name" label="Navn">
      <Input name="name" defaultValue={department?.name} required />
    </Field>
    <Field name="shortName" label="Kortnavn">
      <Input name="shortName" defaultValue={department?.shortName} required />
    </Field>
    <Field name="email" label="E-post">
      <Input
        name="email"
        type="email"
        defaultValue={department?.email}
        required
      />
    </Field>
    <Field name="city" label="By">
      <Input name="city" defaultValue={department?.city} required />
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
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        name="active"
        defaultChecked={department?.active ?? true}
      />{" "}
      Aktiv
    </label>
  </>
);

const routeApi = getRouteApi("/kontrollpanel/avdelinger");

const DepartmentsPage = () => {
  const { departments } = routeApi.useLoaderData();

  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Avdelinger</h1>
      <ul className="grid gap-3">
        {pipe(
          departments,
          Arr.map((department) => (
            <li key={department.id} className="rounded-lg border p-3">
              <details>
                <summary>
                  {department.name} ({department.shortName}) · {department.city}{" "}
                  · {department.email}
                  {department.active ? "" : " · inaktiv"}
                </summary>
                <CommandForm
                  action={saveDepartment}
                  submitLabel="Lagre"
                  className="mt-3 grid max-w-xl gap-3"
                >
                  <DepartmentFields department={department} />
                </CommandForm>
              </details>
            </li>
          ))
        )}
      </ul>
      <h2 className="text-xl font-semibold">Ny avdeling</h2>
      <CommandForm action={saveDepartment} submitLabel="Opprett">
        <DepartmentFields />
      </CommandForm>
    </section>
  );
};

/** C1 departments: an admin creates; an admin or the department's team leader edits. City is unique. */
export const Route = createFileRoute("/kontrollpanel/avdelinger")({
  component: DepartmentsPage,
  loader: () => getDashboard().then(pageData),
});
