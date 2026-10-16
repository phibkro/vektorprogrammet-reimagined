import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { Field, nativeSelectClass } from "@/components/forms";
import { PageHeader } from "@/components/panel/pageHeader";
import { CommandSheet } from "@/components/panel/panelSheets";
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
import { getSponsorsAdmin, saveSponsor } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/sponsorer");

const SponsorsPage = () => {
  const { canManage, sponsors } = routeApi.useLoaderData();

  return (
    <>
      <PageHeader
        title="Sponsorer"
        description="Sponsorene vises nederst på de offentlige sidene, de største først."
        actions={
          canManage && (
            <CommandSheet
              trigger={<Button size="sm" />}
              triggerLabel="Ny sponsor"
              title="Ny sponsor"
              action={saveSponsor}
              submitLabel="Opprett"
            >
              <Field name="name" label="Navn">
                <Input name="name" />
              </Field>
              <Field name="url" label="Nettside">
                <Input name="url" type="url" />
              </Field>
              <Field name="size" label="Størrelse">
                <select
                  name="size"
                  className={nativeSelectClass}
                  defaultValue=""
                >
                  <option value="" disabled>
                    Velg størrelse
                  </option>
                  <option value="small">Liten</option>
                  <option value="medium">Middels</option>
                  <option value="large">Stor</option>
                </select>
              </Field>
              <Field name="logoKey" label="Logo">
                <Input
                  name="logo"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                />
              </Field>
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
                <TableHead>Størrelse</TableHead>
                <TableHead>Nettside</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Arr.map(sponsors, (sponsor) => (
                <TableRow key={sponsor.id}>
                  <TableCell>
                    <span className="font-medium">{sponsor.name}</span>
                  </TableCell>
                  <TableCell>{sponsor.size}</TableCell>
                  <TableCell>
                    <a href={sponsor.url}>{sponsor.url}</a>
                  </TableCell>
                </TableRow>
              ))}
              {sponsors.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3}>Ingen sponsorer ennå.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
};

/** C6 sponsors: name, website and size required (RULE-189); the logo must be an image. */
export const Route = createFileRoute("/kontrollpanel/sponsorer")({
  component: SponsorsPage,
  loader: () => getSponsorsAdmin().then(pageData),
});
