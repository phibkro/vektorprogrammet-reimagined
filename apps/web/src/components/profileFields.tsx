/** The same profile fields are used for registration and both self and leader edits. */
import { Array as Arr } from "effect";

import { Field, nativeSelectClass } from "@/components/forms";
import { Input } from "@/components/ui/input";

interface ProfileValues {
  readonly name: string;
  readonly email: string;
  readonly companyEmail?: string | null;
  readonly fieldOfStudyId: number;
}

interface FieldOption {
  readonly id: number;
  readonly label: string;
}

export const ProfileFields = ({
  profile,
  fieldsOfStudy,
  emailLabel = "Privat e-post",
}: {
  readonly profile?: ProfileValues;
  readonly fieldsOfStudy: readonly FieldOption[];
  readonly emailLabel?: string;
}) => (
  <>
    <Field label="Navn" name="name">
      <Input defaultValue={profile?.name ?? ""} name="name" />
    </Field>
    <Field label={emailLabel} name="email">
      <Input defaultValue={profile?.email ?? ""} name="email" type="email" />
    </Field>
    <Field label="Vektor-e-post" name="companyEmail">
      <Input
        defaultValue={profile?.companyEmail ?? ""}
        name="companyEmail"
        type="email"
      />
    </Field>
    <Field label="Linje" name="fieldOfStudyId">
      <select
        className={nativeSelectClass}
        defaultValue={profile?.fieldOfStudyId}
        name="fieldOfStudyId"
      >
        {Arr.map(fieldsOfStudy, (field) => (
          <option key={field.id} value={field.id}>
            {field.label}
          </option>
        ))}
      </select>
    </Field>
  </>
);
