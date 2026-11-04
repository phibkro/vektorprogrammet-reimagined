import { Link, createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { Choice, firstValue, optionsOf } from "@/components/form/choice";
import { PageHeader } from "@/components/panel/pageHeader";
import { CommandSheet } from "@/components/panel/panelSheets";
import { TeamFields, teamDefaults } from "@/components/panel/teamForms";
import { Badge } from "@/components/ui/badge";
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
import { CreateTeamForm } from "@/forms/teams";
import { getTeams, saveTeam } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";
import { TEAM_FUNCTION_LABEL } from "@/lib/teamLabels";

const routeApi = getRouteApi("/kontrollpanel/team/");

const TeamsPage = () => {
  const { canCreate, departments, teams } = routeApi.useLoaderData();
  const departmentChoices = optionsOf(departments);

  return (
    <>
      <PageHeader
        title="Team"
        description="Teamene i avdelingene dine, og hvem som er med i dem."
        actions={
          canCreate ? (
            <CommandSheet
              trigger={<Button size="sm" />}
              triggerLabel="Nytt team"
              title="Nytt team"
              action={saveTeam}
              schema={CreateTeamForm.schema}
              defaults={{
                ...teamDefaults(),
                departmentId: firstValue(departmentChoices),
                id: "",
              }}
              submitLabel="Opprett"
            >
              {(Field) => (
                <>
                  <Field name="departmentId" label="Avdeling">
                    <Choice options={departmentChoices} />
                  </Field>
                  <TeamFields Field={Field} />
                </>
              )}
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
                <TableHead>Avdeling</TableHead>
                <TableHead>Funksjon</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Arr.map(teams, (team) => (
                <TableRow key={team.id}>
                  <TableCell>
                    <Link
                      to="/kontrollpanel/team/$teamId"
                      params={{ teamId: String(team.id) }}
                      className="font-medium underline"
                    >
                      {team.name}
                    </Link>
                  </TableCell>
                  <TableCell>{team.departmentName}</TableCell>
                  <TableCell>{TEAM_FUNCTION_LABEL[team.function]}</TableCell>
                  <TableCell>
                    <Badge variant={team.active ? "default" : "outline"}>
                      {team.active ? "Aktivt" : "Deaktivert"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
              {teams.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4}>Ingen team å vise ennå.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
};

/** Spec 0006: the teams the principal may see; the create control is there only when `createTeam` is granted. */
export const Route = createFileRoute("/kontrollpanel/team/")({
  component: TeamsPage,
  loader: () => getTeams().then(pageData),
});
