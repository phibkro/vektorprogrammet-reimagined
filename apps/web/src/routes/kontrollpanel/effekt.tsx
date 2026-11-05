import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr, Option, Predicate } from "effect";

import { PageHeader } from "@/components/panel/pageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { impactCsv } from "../../features/impact/domain/lattice";
import * as ImpactMeasures from "../../features/impact/domain/measures";
import type {
  ImpactReport,
  ReportCell,
} from "../../features/impact/domain/services";
import { semesterLabel } from "../../features/organisation/domain/semester";
import { getImpact } from "../../features/panel/server/functions";
import { pageData } from "../../http/outcome";

const routeApi = getRouteApi("/kontrollpanel/effekt");

const ALL_DEPARTMENTS = "Alle avdelinger";

/** What a released cell says on the page: the same cells as the CSV, in Norwegian. */
const releasedText = (released: ImpactMeasures.Released): string =>
  ImpactMeasures.Released.match(released, {
    Published: ({ coverage, value }) =>
      ImpactMeasures.Coverage.match(coverage, {
        Complete: () => String(value),
        Incomplete: ({ reason }) => `minst ${value} (${reason})`,
      }),
    Suppressed: () => ImpactMeasures.HIDDEN.no,
    Unavailable: ({ reason }) => `Utilgjengelig: ${reason}`,
  });

/** A department's id, or `null` for all departments. */
type DepartmentKey = number | null;

/** The released cell of a measure, a semester and a department (or all of them). The report holds every such cell. */
const cellOf = (
  cells: readonly ReportCell[],
  measure: ImpactMeasures.MeasureId,
  semester: ImpactReport["semesters"][number],
  department: DepartmentKey
): ImpactMeasures.Released =>
  Option.match(
    Arr.findFirst(
      cells,
      (cell) =>
        cell.measure === measure &&
        cell.semester.term === semester.term &&
        cell.semester.year === semester.year &&
        ImpactMeasures.Scope.match(cell.scope, {
          All: () => department === null,
          Department: (scope) => scope.department === department,
          School: () => false,
        })
    ),
    {
      onNone: () =>
        ImpactMeasures.Released.cases.Unavailable.make({
          reason: "cellen ble ikke spurt",
        }),
      onSome: ({ released }) => released,
    }
  );

const columnsOf = (
  report: ImpactReport
): readonly { readonly key: DepartmentKey; readonly name: string }[] => [
  { key: null, name: ALL_DEPARTMENTS },
  ...Arr.map(report.departments, ({ id, name }) => ({ key: id, name })),
];

const downloadCsv = (report: ImpactReport) => {
  const blob = new Blob([impactCsv(report)], {
    type: "text/csv;charset=utf-8",
  });

  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "effekt.csv";
  link.click();
  URL.revokeObjectURL(link.href);
};

const ImpactPage = () => {
  const report = routeApi.useLoaderData();
  const columns = columnsOf(report);

  const cells = Arr.flatMap(report.lattices, (lattice) =>
    Predicate.isTagged(lattice, "Released") ? lattice.cells : []
  );

  const refusals = Arr.filter(report.lattices, (lattice) =>
    Predicate.isTagged(lattice, "Refused")
  );

  return (
    <>
      <PageHeader
        title="Effekt"
        description="Antall assistenter, skoler og plasseringer for avsluttede semestre, per avdeling. En celle uten kilde er utilgjengelig: ingenting er anslått."
        actions={
          <Button
            size="sm"
            onClick={() => {
              downloadCsv(report);
            }}
          >
            Last ned CSV
          </Button>
        }
      />
      <p className="text-muted-foreground text-sm">
        {ImpactMeasures.hiddenNote(report.minimum).no}
      </p>
      {report.semesters.length === 0 && (
        <Alert>
          <AlertTitle>Ingen avsluttede semestre ennå</AlertTitle>
          <AlertDescription>
            Tallene vises for semestre som er avsluttet.
          </AlertDescription>
        </Alert>
      )}
      {Arr.map(report.semesters, (semester) => {
        const semesterCells = Arr.filter(
          cells,
          (cell) =>
            cell.semester.term === semester.term &&
            cell.semester.year === semester.year
        );

        const semesterRefusals = Arr.filter(
          refusals,
          (lattice) =>
            lattice.semester.term === semester.term &&
            lattice.semester.year === semester.year
        );

        return (
          <Card key={`${semester.year}${semester.term}`}>
            <CardContent>
              <h2 className="text-lg font-semibold">
                {semesterLabel(semester)}
              </h2>
              {Arr.map(semesterRefusals, (lattice) => (
                <Alert key={lattice.measure}>
                  <AlertTitle>
                    {Option.match(
                      Arr.findFirst(
                        report.measures,
                        (measure) => measure.id === lattice.measure
                      ),
                      {
                        onNone: () => lattice.measure,
                        onSome: (measure) => measure.name.no,
                      }
                    )}{" "}
                    — {semesterLabel(lattice.semester)}
                  </AlertTitle>
                  <AlertDescription>
                    {ImpactMeasures.privacyRefusalNote.no}
                  </AlertDescription>
                </Alert>
              ))}
              {semesterCells.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mål</TableHead>
                      {Arr.map(columns, ({ key, name }) => (
                        <TableHead key={key ?? "alle"}>{name}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Arr.map(
                      Arr.filter(report.measures, (measure) =>
                        Arr.some(
                          semesterCells,
                          (cell) => cell.measure === measure.id
                        )
                      ),
                      (measure) => (
                        <TableRow key={measure.id}>
                          <TableCell>
                            <strong>{measure.name.no}</strong>
                            <br />
                            <span>{measure.definition.no}</span>
                          </TableCell>
                          {Arr.map(columns, ({ key }) => (
                            <TableCell key={key ?? "alle"}>
                              {releasedText(
                                cellOf(semesterCells, measure.id, semester, key)
                              )}
                            </TableCell>
                          ))}
                        </TableRow>
                      )
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        );
      })}
    </>
  );
};

export const Route = createFileRoute("/kontrollpanel/effekt")({
  component: ImpactPage,
  loader: () => getImpact().then(pageData),
});
