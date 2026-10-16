import { Link, createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { CommandForm, Field } from "@/components/forms";
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
import { Textarea } from "@/components/ui/textarea";
import {
  getArticlesAdmin,
  publishArticle,
  saveArticle,
} from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/artikler");

const IMAGE_TYPES = "image/jpeg,image/png,image/webp,image/gif";

const ArticlesPage = () => {
  const { articles, canManage } = routeApi.useLoaderData();

  return (
    <>
      <PageHeader
        title="Artikler"
        description="Publiserte artikler, de nyeste først. Et utkast vises ikke her ennå: publiser eller avpubliser det med artikkelens id."
        actions={
          canManage && (
            <div className="flex flex-wrap gap-2">
              <CommandSheet
                trigger={<Button size="sm" variant="outline" />}
                triggerLabel="Publiser etter id"
                title="Publiser eller avpubliser etter id"
                action={publishArticle}
                submitLabel="Lagre"
              >
                <Field name="id" label="Artikkel-id">
                  <Input name="id" inputMode="numeric" required />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="published" defaultChecked />{" "}
                  Publisert
                </label>
              </CommandSheet>
              <CommandSheet
                trigger={<Button size="sm" />}
                triggerLabel="Ny artikkel"
                title="Ny artikkel"
                action={saveArticle}
                submitLabel="Lagre artikkel"
              >
                <Field name="title" label="Tittel">
                  <Input name="title" required />
                </Field>
                <Field name="body" label="Innhold (HTML)">
                  <Textarea name="body" rows={10} />
                </Field>
                <Field name="imageSmallKey" label="Lite bilde">
                  <Input name="imageSmall" type="file" accept={IMAGE_TYPES} />
                </Field>
                <Field name="imageLargeKey" label="Stort bilde">
                  <Input name="imageLarge" type="file" accept={IMAGE_TYPES} />
                </Field>
                <Field name="file" label="Filtype">
                  <span className="text-sea-ink-soft text-xs">
                    JPEG, PNG, WebP eller GIF.
                  </span>
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="sticky" /> Fest øverst
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="published" /> Publiser nå (ellers
                  kladd)
                </label>
              </CommandSheet>
            </div>
          )
        }
      />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tittel</TableHead>
                <TableHead>Status</TableHead>
                {canManage && (
                  <TableHead>
                    <span className="sr-only">Handlinger</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {Arr.map(articles, (article) => (
                <TableRow key={article.id}>
                  <TableCell>
                    <Link
                      to="/nyhet/$slug"
                      params={{ slug: article.slug }}
                      className="font-medium"
                    >
                      {article.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {article.sticky ? "Publisert, festet" : "Publisert"}
                    </Badge>
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <CommandForm
                        action={publishArticle}
                        submitLabel="Avpubliser"
                        className="flex items-center justify-end gap-2"
                      >
                        <input type="hidden" name="id" value={article.id} />
                      </CommandForm>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {articles.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3}>
                    Ingen publiserte artikler ennå.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
};

/** C5 articles: create (both images required, RULE-182; unique slug, RULE-096; drafts say kladd, RULE-266 fixed) and publish/unpublish. */
export const Route = createFileRoute("/kontrollpanel/artikler")({
  component: ArticlesPage,
  loader: () => getArticlesAdmin().then(pageData),
});
