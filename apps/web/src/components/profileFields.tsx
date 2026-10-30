/** The same profile fields are used for registration and both self and leader edits. */
import { Choice } from "@/components/form/choice";
import type { Option } from "@/components/form/choice";
import type { FieldComponent } from "@/components/form/field";
import { Input } from "@/components/ui/input";

/** The four values of a profile that a form holds, under the names of the forms that register and edit one. */
interface ProfileValues {
  readonly companyEmail?: string;
  readonly email?: string;
  readonly fieldOfStudyId?: string;
  readonly name?: string;
}

interface StoredProfile {
  readonly name: string;
  readonly email: string;
  readonly companyEmail?: string | null;
  readonly fieldOfStudyId: number;
}

/** What a profile form holds when it opens: a stored profile, or a blank one on the first field of study. */
export const profileDefaults = (
  fieldsOfStudy: readonly Option[],
  profile?: StoredProfile
) => ({
  companyEmail: profile?.companyEmail ?? "",
  email: profile?.email ?? "",
  fieldOfStudyId: String(
    profile?.fieldOfStudyId ?? fieldsOfStudy[0]?.value ?? ""
  ),
  name: profile?.name ?? "",
});

export const ProfileFields = ({
  Field,
  fieldsOfStudy,
  emailLabel = "Privat e-post",
}: {
  readonly Field: FieldComponent<ProfileValues>;
  readonly fieldsOfStudy: readonly Option[];
  readonly emailLabel?: string;
}) => (
  <>
    <Field label="Navn" name="name">
      <Input />
    </Field>
    <Field label={emailLabel} name="email">
      <Input type="email" />
    </Field>
    <Field label="Vektor-e-post" name="companyEmail">
      <Input type="email" />
    </Field>
    <Field label="Linje" name="fieldOfStudyId">
      <Choice options={fieldsOfStudy} />
    </Field>
  </>
);
