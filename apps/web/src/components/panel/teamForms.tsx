import { Array as Arr, Record as Rec } from "effect";

import { Field, nativeSelectClass } from "@/components/forms";
import { Input } from "@/components/ui/input";
import { TEAM_FUNCTION_LABEL } from "@/lib/teamLabels";
import type { SemesterChoice } from "@/server/teams";

/** A `<select>` of semesters: the form posts `HOST-2026`, which `semesterOfChoice` reads back. */
export const SemesterSelect = ({
  name,
  choices,
  optional = false,
}: {
  name: string;
  choices: readonly SemesterChoice[];
  /** A blank first entry: the team's default term, for the end of a new membership. */
  optional?: boolean;
}) => (
  <select name={name} className={nativeSelectClass}>
    {optional && <option value="">Teamets standardperiode</option>}
    {Arr.map(choices, (choice) => (
      <option key={choice.value} value={choice.value}>
        {choice.label}
      </option>
    ))}
  </select>
);

interface TeamFieldValues {
  readonly name: string;
  readonly function: string;
  readonly defaultTerm: number;
}

/** The fields of a team, for create and for edit. */
export const TeamFields = ({ team }: { team?: TeamFieldValues }) => (
  <>
    <Field name="name" label="Navn">
      <Input name="name" defaultValue={team?.name} />
    </Field>
    <Field name="function" label="Funksjon">
      <select
        name="function"
        className={nativeSelectClass}
        defaultValue={team?.function ?? "recruitment"}
      >
        {Arr.map(Rec.toEntries(TEAM_FUNCTION_LABEL), ([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </Field>
    <Field name="defaultTerm" label="Standardperiode (semestre)">
      <select
        name="defaultTerm"
        className={nativeSelectClass}
        defaultValue={team?.defaultTerm ?? 2}
      >
        <option value="1">1 semester</option>
        <option value="2">2 semestre</option>
      </select>
    </Field>
  </>
);
