import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr, pipe } from "effect";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getSemesters } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/semestre");

const SemestersPage = () => {
  const { current, semesters } = routeApi.useLoaderData();

  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Semestre</h1>
      {!current.stored && (
        <Alert>
          <AlertTitle>{current.label} er ikke opprettet ennå</AlertTitle>
          <AlertDescription>
            Semestre opprettes automatisk, ikke av en person. Det nåværende
            semesteret vises her så snart den planlagte jobben har kjørt.
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Alle semestre</CardTitle>
          <CardDescription>
            Det nyeste står øverst. Det nåværende og det neste semesteret
            opprettes automatisk.
          </CardDescription>
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
    </section>
  );
};

/**
 * C1 semesters, newest first (RULE-084), the current one marked (RULE-033). No create form: the
 * scheduled job keeps the current and the next semester present (spec 0003, RULE-237).
 */
export const Route = createFileRoute("/kontrollpanel/semestre")({
  component: SemestersPage,
  loader: () => getSemesters().then(pageData),
});
