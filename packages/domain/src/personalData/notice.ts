/**
 * The privacy notice of a form and the record of processing (GDPR Art. 30), both generated from the declarations
 * (spec 0007b). `privacyNotice` lists exactly the personal fields of a form's input schema, each with the purpose, the
 * legal basis, who receives it and how long it is kept, and the fixed paragraphs of `texts.ts`. `recordOfProcessing`
 * groups every personal column of the catalog by what it is for. Both are plain values: the contact form's component
 * and `tools/docgen` render them, so the page and the document cannot say different things.
 */
import { Array as Arr, Order, Predicate, Record as Rec } from "effect";

import type { CatalogOf } from "./catalog.ts";
import type { Approval, PersonalData, Words } from "./declaration.ts";
import { expiryWords, personalColumns, retentionWordsBoth } from "./derive.ts";
import type { FormDeclaration } from "./forms.ts";
import { legalBases, privacyText, purposes } from "./texts.ts";
import type { LegalBasisText } from "./texts.ts";

export interface NoticeEntry {
  readonly field: string;
  readonly label: Words;
  readonly purpose: Words;
  readonly basis: LegalBasisText;
  readonly recipients: Words;
  /** How long the value is kept, from the retention of the column that holds it. */
  readonly kept: Words;
}

export interface PrivacyNotice {
  readonly form: string;
  readonly heading: Words;
  readonly controller: Words;
  readonly rights: Words;
  readonly entries: readonly NoticeEntry[];
  /** `proposed` while the text, or any period that it states, awaits the operator's approval. */
  readonly approval: Approval;
}

/** `proposed` when any period of the retention is still a proposal. */
const approvalOf = (data: PersonalData): Approval => {
  const periods = [
    data.retention.period,
    ...(data.retention.longerWhile === undefined
      ? []
      : [data.retention.longerWhile.period]),
  ];

  return Arr.some(periods, (period) => period.approval === "proposed")
    ? "proposed"
    : "decided";
};

const storedAt = (catalog: CatalogOf, storedIn: string) => {
  const [table = "", column = ""] = storedIn.split(".");
  const declared = catalog[table]?.columns[column];

  return Predicate.isTagged(declared, "PersonalData")
    ? {
        approval: approvalOf(declared),
        kept: retentionWordsBoth(declared.retention, false),
      }
    : {
        approval: "proposed" as const,
        kept: { en: "not declared", no: "ikke deklarert" },
      };
};

/** The notice of `form`: its personal fields only, in the order of the form's declaration. */
export const privacyNotice = (
  form: FormDeclaration,
  catalog: CatalogOf
): PrivacyNotice => {
  const found = Arr.flatMap(Rec.toEntries(form.fields), ([field, declared]) =>
    Predicate.isTagged(declared, "Collected")
      ? [{ declared, field, stored: storedAt(catalog, declared.storedIn) }]
      : []
  );

  const draft =
    privacyText.approval === "proposed" ||
    Arr.some(found, (entry) => entry.stored.approval === "proposed");

  return {
    approval: draft ? "proposed" : "decided",
    controller: privacyText.controller,
    entries: Arr.map(found, ({ declared, field, stored }) => ({
      basis: legalBases[declared.legalBasis],
      field,
      kept: stored.kept,
      label: declared.label,
      purpose: purposes[declared.purpose],
      recipients: declared.recipients,
    })),
    form: form.form,
    heading: privacyText.heading,
    rights: privacyText.rights,
  };
};

/** One line of the record of processing: what a set of columns is for, and how long it is kept. */
export interface RecordRow {
  readonly purpose: Words;
  readonly basis: LegalBasisText;
  /** `table.column`, sorted. */
  readonly data: readonly string[];
  readonly kept: Words;
  readonly atEnd: Words;
  readonly approval: Approval;
}

/** The record of processing activities: every personal column of the catalog, grouped by purpose, basis and retention. */
export const recordOfProcessing = (
  catalog: CatalogOf
): readonly RecordRow[] => {
  const columns = Arr.flatMap(Rec.toEntries(catalog), ([table, declaration]) =>
    Arr.map(personalColumns(declaration), ([column, data]) => ({
      data,
      name: `${table}.${column}`,
    }))
  );

  // A column that is anonymised to another value is still anonymised: the record says that, not to what.
  const groups = Arr.groupBy(columns, ({ data }) =>
    JSON.stringify([
      data.purpose,
      data.legalBasis,
      data.retention,
      data.onExpiry._tag,
    ])
  );

  return Arr.sort(
    Arr.map(Rec.values(groups), (members) => {
      const [{ data }] = members;

      return {
        approval: approvalOf(data),
        atEnd: {
          en: expiryWords(data.onExpiry, "en"),
          no: expiryWords(data.onExpiry, "no"),
        },
        basis: legalBases[data.legalBasis],
        data: Arr.sort(
          Arr.map(members, ({ name }) => name),
          Order.String
        ),
        kept: retentionWordsBoth(data.retention, false),
        purpose: purposes[data.purpose],
      };
    }),
    Order.combine(
      Order.mapInput(Order.String, (row: RecordRow) => row.purpose.en),
      Order.mapInput(Order.String, (row: RecordRow) => row.data[0] ?? "")
    )
  );
};
