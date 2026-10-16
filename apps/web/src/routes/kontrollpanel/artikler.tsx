import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr, pipe } from "effect";

import { CommandForm, Field } from "@/components/forms";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  getArticlesAdmin,
  publishArticle,
  saveArticle,
} from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/artikler");

const ArticlesPage = () => {
  const articles = routeApi.useLoaderData();

  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Artikler</h1>
      <ul className="grid gap-2">
        {pipe(
          articles,
          Arr.map((article) => (
            <li key={article.id} className="flex flex-wrap items-center gap-3">
              <a href={`/nyhet/${article.slug}`}>{article.title}</a>
              {article.sticky && <span className="text-xs">(festet)</span>}
              <CommandForm
                action={publishArticle}
                submitLabel="Avpubliser"
                className="flex gap-2"
              >
                <input type="hidden" name="id" value={article.id} />
              </CommandForm>
            </li>
          ))
        )}
      </ul>
      <h2 className="text-xl font-semibold">
        Publiser eller avpubliser etter id
      </h2>
      <CommandForm action={publishArticle} submitLabel="Lagre">
        <Field name="id" label="Artikkel-id">
          <Input id="article-id" name="id" inputMode="numeric" required />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="published" defaultChecked /> Publisert
        </label>
      </CommandForm>
      <h2 className="text-xl font-semibold">Ny artikkel</h2>
      <CommandForm action={saveArticle} submitLabel="Lagre artikkel">
        <Field name="title" label="Tittel">
          <Input id="title" name="title" required />
        </Field>
        <Field name="body" label="Innhold (HTML)">
          <Textarea id="body" name="body" rows={10} />
        </Field>
        <Field name="imageSmallKey" label="Lite bilde">
          <Input
            id="imageSmall"
            name="imageSmall"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
          />
        </Field>
        <Field name="imageLargeKey" label="Stort bilde">
          <Input
            id="imageLarge"
            name="imageLarge"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
          />
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
          <input type="checkbox" name="published" /> Publiser nå (ellers kladd)
        </label>
      </CommandForm>
    </section>
  );
};

/** C5 articles: create (both images required, RULE-182; unique slug, RULE-096; drafts say kladd, RULE-266 fixed) and publish/unpublish. */
export const Route = createFileRoute("/kontrollpanel/artikler")({
  component: ArticlesPage,
  loader: () => getArticlesAdmin().then(pageData),
});
