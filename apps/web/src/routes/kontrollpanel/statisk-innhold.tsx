import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr, pipe } from "effect";

import { CommandForm, Field } from "@/components/forms";
import { Textarea } from "@/components/ui/textarea";
import {
  getStaticContentAdmin,
  saveStaticContent,
} from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/statisk-innhold");

const StaticContentPage = () => {
  const blocks = routeApi.useLoaderData();

  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Statisk innhold</h1>
      {pipe(
        blocks,
        Arr.map((block) => (
          <details key={block.key} className="rounded-lg border p-3">
            <summary>
              {block.page} · {block.key}
            </summary>
            <CommandForm
              action={saveStaticContent}
              submitLabel="Lagre"
              className="mt-3 grid gap-3"
            >
              <input type="hidden" name="editorId" value={block.key} />
              <Field name="html" label="HTML">
                <Textarea
                  id={`html-${block.key}`}
                  name="html"
                  rows={8}
                  defaultValue={block.html}
                />
              </Field>
            </CommandForm>
          </details>
        ))
      )}
    </section>
  );
};

/** C4 static text blocks: admin or executive board only (RULE-296); HTML is sanitized (RULE-133 replacement). */
export const Route = createFileRoute("/kontrollpanel/statisk-innhold")({
  component: StaticContentPage,
  loader: () => getStaticContentAdmin().then(pageData),
});
