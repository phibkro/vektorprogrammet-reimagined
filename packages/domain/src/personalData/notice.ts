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
import {
  expiryWords,
  personalColumns,
  retentionIsProposed,
  retentionWordsBoth,
} from "./derive.ts";
import type { Language } from "./duration.ts";
import type { FormDeclaration } from "./forms.ts";
import {
  NOTICE_DECISIONS,
  basesApproval,
  legalBases,
  noticeDecisionWords,
  privacyText,
  purposes,
} from "./texts.ts";
import type { LegalBasisText, NoticeDecision } from "./texts.ts";

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
  /** What awaits the operator's approval: the notice's text, a legal basis or a period that it states. Empty when it is final. */
  readonly open: readonly NoticeDecision[];
}

/** The decisions that a notice awaits, in the order that a draft note names them: those that are still `proposed`. */
export const openDecisions = (
  approvals: Readonly<Record<NoticeDecision, Approval>>
): readonly NoticeDecision[] =>
  Arr.filter(
    NOTICE_DECISIONS,
    (decision) => approvals[decision] === "proposed"
  );

/** The parts of a list in a sentence: "a", "a og b", "a, b og c". */
const listed = (parts: readonly string[], and: string): string =>
  parts.length > 1
    ? `${Arr.join(Arr.dropRight(parts, 1), ", ")} ${and} ${Arr.join(Arr.takeRight(parts, 1), "")}`
    : Arr.join(parts, "");

/**
 * The draft note of a notice, from what it awaits: "Utkast: teksten og periodene venter på godkjenning." Each open
 * decision is named and no other, and a notice that awaits nothing has no note (spec 0007b R4). The page and the
 * generated document print this one sentence.
 */
export const draftNote = (
  open: readonly NoticeDecision[],
  language: Language
): string | undefined => {
  if (!Arr.isReadonlyArrayNonEmpty(open)) {
    return undefined;
  }

  const names = listed(
    Arr.map(open, (decision) => noticeDecisionWords[decision][language]),
    language === "no" ? "og" : "and"
  );

  return language === "no"
    ? `Utkast: ${names} venter på godkjenning.`
    : `Draft, awaiting the operator's approval: ${names}.`;
};

/** `proposed` when any period of the retention is still a proposal. */
const approvalOf = (data: PersonalData): Approval =>
  retentionIsProposed(data.retention) ? "proposed" : "decided";

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

  const open = openDecisions({
    bases: basesApproval,
    periods: Arr.some(found, (entry) => entry.stored.approval === "proposed")
      ? "proposed"
      : "decided",
    text: privacyText.approval,
  });

  return {
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
    open,
    rights: privacyText.rights,
  };
};

/**
 * One line of the record of processing: what a set of columns is for, and how long it is kept. The two approvals are
 * separate because the operator decides them separately: `periodApproval` is the period's (the brief's decisions fix
 * periods, one by one), `basisApproval` is the legal basis's (`basesApproval` in `texts.ts`, one declaration for the
 * whole record).
 */
export interface RecordRow {
  readonly purpose: Words;
  readonly basis: LegalBasisText;
  /** `table.column`, sorted. */
  readonly data: readonly string[];
  readonly kept: Words;
  readonly atEnd: Words;
  readonly periodApproval: Approval;
  readonly basisApproval: Approval;
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
        atEnd: {
          en: expiryWords(data.onExpiry, "en"),
          no: expiryWords(data.onExpiry, "no"),
        },
        basis: legalBases[data.legalBasis],
        basisApproval: basesApproval,
        data: Arr.sort(
          Arr.map(members, ({ name }) => name),
          Order.String
        ),
        kept: retentionWordsBoth(data.retention, false),
        periodApproval: approvalOf(data),
        purpose: purposes[data.purpose],
      };
    }),
    Order.combine(
      Order.mapInput(Order.String, (row: RecordRow) => row.purpose.en),
      Order.mapInput(Order.String, (row: RecordRow) => row.data[0] ?? "")
    )
  );
};
