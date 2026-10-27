import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { Field, nativeSelectClass } from "@/components/forms";
import { PageHeader } from "@/components/panel/pageHeader";
import { CommandSheet } from "@/components/panel/panelSheets";
import { Badge } from "@/components/ui/badge";
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
import {
  getAdmins,
  grantAdmin,
  revokeAdmin,
} from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/administratorer");

const AdminsPage = () => {
  const { candidates, grants } = routeApi.useLoaderData();

  return (
    <>
      <PageHeader
        title="Administratorer"
        description="Hvem som er administrator, og til når. Ingen kan gi seg selv en plass eller ta bort sin egen, og den siste plassen som varer ut semesteret blir stående."
        actions={
          <CommandSheet
            trigger={<Button size="sm" />}
            triggerLabel="Gi administratorplass"
            title="Gi administratorplass"
            action={grantAdmin}
            submitLabel="Gi plass"
          >
            <Field name="personId" label="Person">
              <select name="personId" className={nativeSelectClass}>
                {Arr.map(candidates, (person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field name="until" label="Til (dato og klokkeslett)">
              <Input name="until" type="datetime-local" />
            </Field>
          </CommandSheet>
        }
      />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Navn</TableHead>
                <TableHead>Til</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>
                  <span className="sr-only">Handlinger</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Arr.map(grants, (grant) => (
                <TableRow key={grant.id}>
                  <TableCell>
                    <span className="font-medium">{grant.personName}</span>
                  </TableCell>
                  <TableCell>{grant.until}</TableCell>
                  <TableCell>
                    <Badge variant={grant.valid ? "default" : "outline"}>
                      {grant.valid ? "Gjelder" : "Utløpt"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {!grant.own && (
                      <CommandSheet
                        trigger={
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Fjern plassen til ${grant.personName}`}
                          />
                        }
                        triggerLabel="Fjern plassen"
                        title={`Fjern plassen til ${grant.personName}`}
                        action={revokeAdmin}
                        submitLabel="Fjern"
                      >
                        <input type="hidden" name="id" value={grant.id} />
                      </CommandSheet>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {grants.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4}>Ingen administratorplasser.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
};

/** Spec 0006: the admin list, for a principal that holds `createAdminGrant`; revoking one's own place is not offered. */
export const Route = createFileRoute("/kontrollpanel/administratorer")({
  component: AdminsPage,
  loader: () => getAdmins().then(pageData),
});
