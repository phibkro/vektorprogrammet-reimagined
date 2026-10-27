/** The control panel's two controls over a person's data (spec 0007b): merging two records, and erasing one person. */
import { Array as Arr } from "effect";

import { Field, nativeSelectClass } from "@/components/forms";
import { CommandSheet } from "@/components/panel/panelSheets";
import { Button } from "@/components/ui/button";
import { mergePeople } from "@/functions/panel.functions";
import { erasePersonData } from "@/functions/personalData.functions";

interface PersonOption {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

/** Two records of one person have the same name and often the same address, so the list shows both. */
const PersonSelect = ({
  name,
  people,
}: {
  readonly name: string;
  readonly people: readonly PersonOption[];
}) => (
  <select className={nativeSelectClass} name={name}>
    {Arr.map(people, (person) => (
      <option key={person.id} value={person.id}>
        {`${person.name} (${person.email})`}
      </option>
    ))}
  </select>
);

/** Two records of one person become one: the second follows the first, and is left without name and addresses. */
export const MergeSheet = ({
  people,
}: {
  readonly people: readonly PersonOption[];
}) => (
  <CommandSheet
    trigger={<Button size="sm" variant="outline" />}
    triggerLabel="Slå sammen personer"
    title="Slå sammen to personer"
    description="To poster om samme person blir én. Alt som hører til den andre personen flyttes til den første, og den andre står igjen uten navn og kontaktopplysninger. Handlingen kan ikke angres."
    action={mergePeople}
    submitLabel="Slå sammen"
  >
    <Field label="Personen som blir stående" name="into">
      <PersonSelect name="into" people={people} />
    </Field>
    <Field label="Personen som slås sammen inn i den" name="from">
      <PersonSelect name="from" people={people} />
    </Field>
  </CommandSheet>
);

/** An erasure on someone's behalf: for a person who has no account, or who asked by e-mail. */
export const EraseSheet = ({ person }: { readonly person: PersonOption }) => (
  <CommandSheet
    trigger={
      <Button
        aria-label={`Slett opplysningene til ${person.name}`}
        size="sm"
        variant="outline"
      />
    }
    triggerLabel="Slett opplysninger"
    title={`Slett opplysningene til ${person.name}`}
    description="Navn, e-post og konto blir slettet. Historikken om medlemskap og tidligere roller blir stående uten navn og kontaktopplysninger. Handlingen kan ikke angres."
    action={erasePersonData}
    submitLabel="Slett opplysningene"
  >
    <input name="personId" type="hidden" value={person.id} />
  </CommandSheet>
);
