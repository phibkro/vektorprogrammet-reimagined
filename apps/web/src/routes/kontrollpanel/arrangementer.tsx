import { createFileRoute } from "@tanstack/react-router";
import { CommandForm, Field, nativeSelectClass } from "@/components/forms";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getSocialEvents, saveSocialEvent } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

/** C8 social events: title required, link ≤ 250, end after start (RULE-188); badges (RULE-085). */
export const Route = createFileRoute("/kontrollpanel/arrangementer")({
  loader: () => getSocialEvents().then(pageData),
  component: SocialEventsPage,
});

function SocialEventsPage() {
  const { events, departments, semesters, departmentId, currentSemesterId } = Route.useLoaderData();
  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Arrangementer</h1>
      <ul className="grid gap-1">
        {events.map((event) => (
          <li key={event.id}>
            {event.title} · {event.startsAt}
            {event.badge !== null && <strong> · {event.badge}</strong>}
          </li>
        ))}
      </ul>
      <h2 className="text-xl font-semibold">Nytt arrangement</h2>
      <CommandForm action={saveSocialEvent} submitLabel="Opprett">
        <Field name="title" label="Tittel">
          <Input id="title" name="title" />
        </Field>
        <Field name="description" label="Beskrivelse">
          <Textarea id="description" name="description" rows={4} />
        </Field>
        <Field name="startsAt" label="Start (norsk tid)">
          <Input id="startsAt" name="startsAt" type="datetime-local" required />
        </Field>
        <Field name="endsAt" label="Slutt (norsk tid)">
          <Input id="endsAt" name="endsAt" type="datetime-local" required />
        </Field>
        <Field name="link" label="Lenke">
          <Input id="link" name="link" maxLength={250} />
        </Field>
        <Field name="departmentId" label="Avdeling">
          <select
            id="departmentId"
            name="departmentId"
            className={nativeSelectClass}
            defaultValue={departmentId ?? undefined}
          >
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        </Field>
        <Field name="semesterId" label="Semester">
          <select
            id="semesterId"
            name="semesterId"
            className={nativeSelectClass}
            defaultValue={currentSemesterId}
          >
            {semesters.map((semester) => (
              <option key={semester.id} value={semester.id}>
                {semester.label}
              </option>
            ))}
          </select>
        </Field>
      </CommandForm>
    </section>
  );
}
