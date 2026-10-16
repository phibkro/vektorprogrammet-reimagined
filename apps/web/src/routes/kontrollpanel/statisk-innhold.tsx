import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { Field } from "@/components/forms";
import { PageHeader } from "@/components/panel/pageHeader";
import { CommandSheet } from "@/components/panel/panelSheets";
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
import { Textarea } from "@/components/ui/textarea";
import {
  getStaticContentAdmin,
  saveStaticContent,
} from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/statisk-innhold");

const StaticContentPage = () => {
  const { blocks, canEdit } = routeApi.useLoaderData();

  return (
    <>
      <PageHeader
        title="Statisk innhold"
        description="Tekstblokkene de offentlige sidene viser. HTML renses når den lagres og når den vises."
      />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Side</TableHead>
                <TableHead>Blokk</TableHead>
                <TableHead>Innhold</TableHead>
                {canEdit && (
                  <TableHead>
                    <span className="sr-only">Handlinger</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {Arr.map(blocks, (block) => (
                <TableRow key={block.key}>
                  <TableCell>{block.page}</TableCell>
                  <TableCell>
                    <code>{block.key}</code>
                  </TableCell>
                  <TableCell className="max-w-xs">
                    <span className="text-muted-foreground line-clamp-2 text-xs">
                      {block.html === "" ? "Ikke skrevet ennå." : block.html}
                    </span>
                  </TableCell>
                  {canEdit && (
                    <TableCell className="text-right">
                      <CommandSheet
                        trigger={
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Rediger ${block.key}`}
                          />
                        }
                        triggerLabel="Rediger"
                        title={`Rediger ${block.key}`}
                        description={`Blokken vises på siden ${block.page}.`}
                        action={saveStaticContent}
                        submitLabel="Lagre"
                      >
                        <input
                          type="hidden"
                          name="editorId"
                          value={block.key}
                        />
                        <Field name="html" label="HTML">
                          <Textarea
                            name="html"
                            rows={12}
                            defaultValue={block.html}
                          />
                        </Field>
                      </CommandSheet>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
};

/** C4 static text blocks: admin or executive board only (RULE-296); HTML is sanitized (RULE-133 replacement). */
export const Route = createFileRoute("/kontrollpanel/statisk-innhold")({
  component: StaticContentPage,
  loader: () => getStaticContentAdmin().then(pageData),
});
