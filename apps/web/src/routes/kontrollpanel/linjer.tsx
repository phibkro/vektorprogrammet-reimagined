import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr, pipe } from "effect";

import { CommandForm, Field } from "@/components/forms";
import { Input } from "@/components/ui/input";
import {
  getFieldsOfStudy,
  saveFieldOfStudy,
} from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/linjer");

const FieldsOfStudyPage = () => {
  const { departmentId, fieldsOfStudy } = routeApi.useLoaderData();

  if (departmentId === null) {
    return <p>Du må være innlogget som ansatt.</p>;
  }

  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Linjer (avdeling {departmentId})</h1>
      <ul className="grid gap-3">
        {pipe(
          fieldsOfStudy,
          Arr.map((field) => (
            <li key={field.id} className="rounded-lg border p-3">
              <details>
                <summary>
                  {field.name} ({field.shortName})
                </summary>
                <CommandForm
                  action={saveFieldOfStudy}
                  submitLabel="Gi nytt navn"
                  className="mt-3 grid max-w-xl gap-3"
                >
                  <input type="hidden" name="id" value={field.id} />
                  <Field name="name" label="Navn">
                    <Input name="name" defaultValue={field.name} required />
                  </Field>
                  <Field name="shortName" label="Kortnavn">
                    <Input
                      name="shortName"
                      defaultValue={field.shortName}
                      required
                    />
                  </Field>
                </CommandForm>
              </details>
            </li>
          ))
        )}
      </ul>
      <h2 className="text-xl font-semibold">Ny linje</h2>
      <CommandForm action={saveFieldOfStudy} submitLabel="Opprett">
        <Field name="name" label="Navn">
          <Input name="name" required />
        </Field>
        <Field name="shortName" label="Kortnavn">
          <Input name="shortName" required />
        </Field>
      </CommandForm>
    </section>
  );
};

/** C1 fields of study of the actor's own department only (RULE-139). */
export const Route = createFileRoute("/kontrollpanel/linjer")({
  component: FieldsOfStudyPage,
  loader: () => getFieldsOfStudy().then(pageData),
});
