import { Array as Arr, Record as Rec } from "effect";

import { Choice } from "@/components/form/choice";
import type { FieldComponent } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { TEAM_FUNCTION_LABEL } from "@/lib/teamLabels";

/** The values of a team that its form holds, under the names of the forms that create and change one. */
interface TeamValues {
  readonly defaultTerm?: string;
  readonly function?: string;
  readonly groupEmail?: string;
  readonly name?: string;
}

interface StoredTeam {
  readonly name: string;
  readonly function: string;
  readonly defaultTerm: number;
  readonly groupEmail: string | null;
}

const FUNCTIONS = Arr.map(
  Rec.toEntries(TEAM_FUNCTION_LABEL),
  ([value, label]) => ({
    label,
    value,
  })
);

const TERMS = [
  { label: "1 semester", value: "1" },
  { label: "2 semestre", value: "2" },
];

/** What a team's form holds when it opens: the stored team, or a new one for the recruitment function and two semesters. */
export const teamDefaults = (team?: StoredTeam) => ({
  defaultTerm: String(team?.defaultTerm ?? 2),
  function: team?.function ?? "recruitment",
  groupEmail: team?.groupEmail ?? "",
  name: team?.name ?? "",
});

/** The fields of a team, for create and for edit. */
export const TeamFields = ({
  Field,
}: {
  Field: FieldComponent<TeamValues>;
}) => (
  <>
    <Field name="name" label="Navn">
      <Input />
    </Field>
    <Field name="groupEmail" label="Google-gruppeadresse">
      <Input type="email" />
    </Field>
    <Field name="function" label="Funksjon">
      <Choice options={FUNCTIONS} />
    </Field>
    <Field name="defaultTerm" label="Standardperiode (semestre)">
      <Choice options={TERMS} />
    </Field>
  </>
);
