import { Array as Arr } from "effect";

import { CheckGroup, Choice } from "@/components/form/choice";
import type { Option } from "@/components/form/choice";
import type { FieldComponent } from "@/components/form/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  SOURCE_PREFIX,
  SPECIAL_NEEDS_CONSENT,
  SPECIAL_NEEDS_TEXT,
  TEAM_PREFIX,
  WEEKDAY_PREFIX,
} from "@/forms/admission";
import type { FormText } from "@/forms/formSchema";

/** What the applicant's fields offer: the closed answers of the domain, and the department's fields of study and teams. */
export interface ApplicantOptions {
  readonly answers: {
    readonly bolk: readonly Option[];
    readonly gender: readonly Option[];
    readonly heardAbout: readonly Option[];
    readonly weekdays: readonly Option[];
  };
  /** The text of the consent that special needs rest on; the person reads it beside the box. */
  readonly consent: string;
  readonly fieldsOfStudy: readonly Option[];
  readonly teams: readonly Option[];
}

const YEARS: readonly Option[] = Arr.map([1, 2, 3, 4, 5], (year) => ({
  label: `${year}. årstrinn`,
  value: String(year),
}));

/** One box of a set: its name is the one the form's text step reads (`weekday-Monday`), so a post without script carries it. */
const Box = ({
  Field,
  name,
  option,
}: {
  readonly Field: FieldComponent<FormText>;
  readonly name: string;
  readonly option: Option;
}) => (
  <Field label={option.label} name={name}>
    <Checkbox name={name} />
  </Field>
);

/** A set of boxes under one legend: `name` is the path of the domain's issue on the whole set. */
const Boxes = ({
  Field,
  label,
  name,
  options,
  prefix,
}: {
  readonly Field: FieldComponent<FormText>;
  readonly label: string;
  readonly name: string;
  readonly options: readonly Option[];
  readonly prefix: string;
}) => (
  <Field label={label} name={name}>
    <CheckGroup>
      {Arr.map(options, (option) => (
        <Box
          Field={Field}
          key={option.value}
          name={`${prefix}${option.value}`}
          option={option}
        />
      ))}
    </CheckGroup>
  </Field>
);

/**
 * What an applicant gives (RULE-105, 129, 138), the same for the public form and for staff who register one at a stand:
 * one input schema, one set of fields. The e-mail address is the applicant's own; the department's field of study and
 * teams are the choices of the department.
 */
export const ApplicantFields = ({
  Field,
  options,
}: {
  readonly Field: FieldComponent<FormText>;
  readonly options: ApplicantOptions;
}) => (
  <>
    <Field label="Navn" name="name">
      <Input autoComplete="name" maxLength={255} required />
    </Field>
    <Field label="E-post" name="email">
      <Input autoComplete="email" required type="email" />
    </Field>
    <Field label="Linje" name="fieldOfStudyId">
      <Choice blank="Velg linje" options={options.fieldsOfStudy} required />
    </Field>
    <Field label="Årstrinn" name="yearOfStudy">
      <Choice blank="Velg årstrinn" options={YEARS} required />
    </Field>
    <Field label="Bolk" name="bolk">
      <Choice blank="Velg bolk" options={options.answers.bolk} required />
    </Field>
    <Boxes
      Field={Field}
      label="Dagene som passer for deg"
      name="weekdays"
      options={options.answers.weekdays}
      prefix={WEEKDAY_PREFIX}
    />
    <Field label="Jeg kan ta dobbel stilling (to skoler)" name="doublePosition">
      <Checkbox name="doublePosition" />
    </Field>
    {options.teams.length > 0 && (
      <Boxes
        Field={Field}
        label="Team du er interessert i (valgfritt)"
        name="teamInterest"
        options={options.teams}
        prefix={TEAM_PREFIX}
      />
    )}
    <Field label="Kjønn (valgfritt, brukes bare i totaler)" name="gender">
      <Choice blank="Ønsker ikke å oppgi" options={options.answers.gender} />
    </Field>
    <Boxes
      Field={Field}
      label="Hvor hørte du om oss? (valgfritt)"
      name="heardAbout"
      options={options.answers.heardAbout}
      prefix={SOURCE_PREFIX}
    />
    <Field label="Spesielle behov (valgfritt)" name={SPECIAL_NEEDS_TEXT}>
      <Textarea maxLength={1000} rows={3} />
    </Field>
    <Field label={options.consent} name={SPECIAL_NEEDS_CONSENT}>
      <Checkbox name={SPECIAL_NEEDS_CONSENT} />
    </Field>
  </>
);
