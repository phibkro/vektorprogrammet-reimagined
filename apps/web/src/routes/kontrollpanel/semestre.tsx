import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr, pipe } from "effect";

import { CommandForm, Field } from "@/components/forms";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getSemesters, saveSemester } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const TERMS = [
  { label: "Vår", value: "VAR" },
  { label: "Høst", value: "HOST" },
];

const routeApi = getRouteApi("/kontrollpanel/semestre");

const SemestersPage = () => {
  const { proposed, semesters, years } = routeApi.useLoaderData();

  const yearItems = Arr.map(years, (year) => ({
    label: String(year),
    value: String(year),
  }));

  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Semestre</h1>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Alle semestre</CardTitle>
            <CardDescription>Det nyeste står øverst.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Semester</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pipe(
                  semesters,
                  Arr.map((semester) => (
                    <TableRow key={semester.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {semester.label}
                          {semester.current && <Badge>Nåværende</Badge>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Opprett neste semester</CardTitle>
            <CardDescription>
              Velg vår eller høst og et år fra 2012 til neste år. Et semester
              som finnes fra før kan ikke opprettes på nytt.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CommandForm
              key={`${proposed.term}-${proposed.year}`}
              action={saveSemester}
              submitLabel="Opprett semester"
            >
              <Field name="term" label="Semester">
                <Select name="term" defaultValue={proposed.term} items={TERMS}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {pipe(
                      TERMS,
                      Arr.map((term) => (
                        <SelectItem key={term.value} value={term.value}>
                          {term.label}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </Field>
              <Field name="year" label="År">
                <Select
                  name="year"
                  defaultValue={String(proposed.year)}
                  items={yearItems}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {pipe(
                      yearItems,
                      Arr.map((year) => (
                        <SelectItem key={year.value} value={year.value}>
                          {year.label}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </Field>
            </CommandForm>
          </CardContent>
        </Card>
      </div>
    </section>
  );
};

/** C1 semesters, newest first (RULE-084); create refuses duplicates (RULE-144); years 2012…next (RULE-190). */
export const Route = createFileRoute("/kontrollpanel/semestre")({
  component: SemestersPage,
  loader: () => getSemesters().then(pageData),
});
