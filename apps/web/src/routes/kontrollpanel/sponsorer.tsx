import { createFileRoute } from "@tanstack/react-router";
import { CommandForm, Field, nativeSelectClass } from "@/components/forms";
import { Input } from "@/components/ui/input";
import { getSponsorsAdmin, saveSponsor } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

/** C6 sponsors: name, website and size required (RULE-189); the logo must be an image. */
export const Route = createFileRoute("/kontrollpanel/sponsorer")({
  loader: () => getSponsorsAdmin().then(pageData),
  component: SponsorsPage,
});

function SponsorsPage() {
  const sponsors = Route.useLoaderData();
  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Sponsorer</h1>
      <ul className="grid gap-1">
        {sponsors.map((sponsor) => (
          <li key={sponsor.id}>
            {sponsor.name} · {sponsor.size} · <a href={sponsor.url}>{sponsor.url}</a>
          </li>
        ))}
      </ul>
      <h2 className="text-xl font-semibold">Ny sponsor</h2>
      <CommandForm action={saveSponsor} submitLabel="Opprett">
        <Field name="name" label="Navn">
          <Input id="name" name="name" />
        </Field>
        <Field name="url" label="Nettside">
          <Input id="url" name="url" type="url" />
        </Field>
        <Field name="size" label="Størrelse">
          <select id="size" name="size" className={nativeSelectClass} defaultValue="">
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
            id="logo"
            name="logo"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
          />
        </Field>
      </CommandForm>
    </section>
  );
}
