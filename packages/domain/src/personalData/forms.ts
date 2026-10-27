/**
 * What a form collects (spec 0007b, falsifier 1): the declaration of a form's input schema. Every field of the schema
 * is either `Collected` (why, on which basis, who gets it, and the stored column that holds it, which supplies the
 * retention) or `NotPersonal` (and why). The fields are typed by the schema's own, so a field that is added to a form
 * without a declaration does not compile; a test checks the same at run time, and that each `storedIn` names a column the
 * catalog declares as personal. The privacy notice on the form is generated from this and the catalog (`notice.ts`).
 */
import { Record as Rec, Schema } from "effect";

import { LegalBasis, Purpose, Words } from "./declaration.ts";

export const FormField = Schema.TaggedUnion({
  Collected: {
    label: Words,
    legalBasis: LegalBasis,
    purpose: Purpose,
    /** Who receives the data besides the organisation's own system. */
    recipients: Words,
    /** The stored column that holds the value: `table.column`. Its retention is the field's. */
    storedIn: Schema.String,
  },
  NotPersonal: { reason: Schema.String },
});

export type FormField = typeof FormField.Type;

export type Collected = Extract<FormField, { readonly _tag: "Collected" }>;

export const collected = (fields: {
  readonly label: Words;
  readonly legalBasis: LegalBasis;
  readonly purpose: Purpose;
  readonly recipients: Words;
  readonly storedIn: string;
}): FormField => FormField.cases.Collected.make(fields);

export const notCollected = (reason: string): FormField =>
  FormField.cases.NotPersonal.make({ reason });

export interface FormDeclaration {
  readonly form: string;
  readonly title: Words;
  /** The input schema's field names, each with its declaration. */
  readonly fields: Readonly<Record<string, FormField>>;
  /** The names of the schema's own fields, which the declaration must cover exactly. */
  readonly schemaFields: readonly string[];
}

/** A form's declaration, typed by the fields of its input schema: a field without a declaration is a compile error. */
export const form = <const Fields extends Schema.Struct.Fields>(declaration: {
  readonly form: string;
  readonly title: Words;
  readonly schema: Schema.Struct<Fields>;
  readonly fields: { readonly [Name in keyof Fields & string]: FormField };
}): FormDeclaration => ({
  fields: declaration.fields,
  form: declaration.form,
  schemaFields: Rec.keys(declaration.schema.fields),
  title: declaration.title,
});
