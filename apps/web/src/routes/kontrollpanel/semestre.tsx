import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr, pipe } from "effect";

import { CommandForm, Field, nativeSelectClass } from "@/components/forms";
import { getSemesters, saveSemester } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/semestre");

const SemestersPage = () => {
  const { semesters, years } = routeApi.useLoaderData();

  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Semestre</h1>
      <ul className="grid gap-1">
        {pipe(
          semesters,
          Arr.map((semester) => <li key={semester.id}>{semester.label}</li>)
        )}
      </ul>
      <h2 className="text-xl font-semibold">Nytt semester</h2>
      <CommandForm action={saveSemester} submitLabel="Opprett">
        <Field name="term" label="Semester">
          <select
            id="term"
            name="term"
            className={nativeSelectClass}
            defaultValue="HOST"
          >
            <option value="VAR">Vår</option>
            <option value="HOST">Høst</option>
          </select>
        </Field>
        <Field name="year" label="År">
          <select id="year" name="year" className={nativeSelectClass}>
            {pipe(
              years,
              Arr.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))
            )}
          </select>
        </Field>
      </CommandForm>
    </section>
  );
};

/** C1 semesters, newest first (RULE-084); create refuses duplicates (RULE-144); years 2012…next (RULE-190). */
export const Route = createFileRoute("/kontrollpanel/semestre")({
  component: SemestersPage,
  loader: () => getSemesters().then(pageData),
});
