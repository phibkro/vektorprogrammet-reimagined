/**
 * Personal data is declared once per stored column (ADR 0004, spec 0007b). A column is `PersonalData` (why it is
 * processed, on which legal basis, how long it is kept and what happens then) or `NotPersonal` (and why). The record of
 * processing, the privacy notice, the nightly retention job, the export, the erasure and the merge are all read from
 * this declaration, so none of them keeps a list of its own. A test closes it over the migrated schema (every column,
 * both ways) and over every foreign key to `person`.
 *
 * These are plain data with constructors; the derivations are in `derive.ts`, the values in `periods.ts` and
 * `texts.ts`, and each domain declares its tables beside its entities (`teams/personalData.ts`, …).
 */
import { Array as Arr, Record as Rec, Schema } from "effect";

/** The consents a person gives. Each has a declared, versioned text (`texts.ts`). */
export const ConsentKind = Schema.Literals(["keepDetails", "news", "photo"]);

export type ConsentKind = typeof ConsentKind.Type;

/** The legal bases that the declarations name: GDPR Art. 6(1)(a), (b), (c), (f) and Art. 9(2)(a). */
export const LegalBasis = Schema.Literals([
  "consent",
  "contract",
  "explicitConsent",
  "legalObligation",
  "legitimateInterest",
]);

export type LegalBasis = typeof LegalBasis.Type;

/** Why a field is processed: a closed set, each with its wording in both languages (`texts.ts`). */
export const Purpose = Schema.Literals([
  "accountability",
  "admission",
  "alumni",
  "consents",
  "contact",
  "delivery",
  "digest",
  "engagementHistory",
  "engagements",
  "files",
  "jobs",
  "login",
  "mailbox",
  "photo",
  "places",
  "welcome",
  "workspace",
]);

export type Purpose = typeof Purpose.Type;

/** A calendar duration, added in Oslo wall-clock time (`afterDuration`, spec 0021). */
export const Duration = Schema.TaggedUnion({
  Days: { count: Schema.Int },
  Months: { count: Schema.Int },
  Years: { count: Schema.Int },
});

export type Duration = typeof Duration.Type;

export const days = (count: number): Duration =>
  Duration.cases.Days.make({ count });

export const months = (count: number): Duration =>
  Duration.cases.Months.make({ count });

export const years = (count: number): Duration =>
  Duration.cases.Years.make({ count });

/** Whether the operator has decided a value or it is still a proposal that waits for approval. */
export const Approval = Schema.Literals(["decided", "proposed"]);

export type Approval = typeof Approval.Type;

/** A retention period as one declared value: approving it is a one-line change of `approval`. */
export const Period = Schema.Struct({
  approval: Approval,
  duration: Duration,
});

export type Period = typeof Period.Type;

export const period = (duration: Duration, approval: Approval): Period => ({
  approval,
  duration,
});

/** A short text in both languages: what a person reads, and what the system documentation says. */
export const Words = Schema.Struct({ en: Schema.String, no: Schema.String });

export type Words = typeof Words.Type;

/**
 * When a retention period starts, from a closed set; each is an instant that `retentionEnd.ts` computes from facts that
 * an adapter reads (spec 0021):
 * - `Column`: an instant column of the same row (`created_at`, `expires_at`, `at`), with the event that it records, in
 *   words, for the notice and the record of processing.
 * - `LastActivityEnd`: the later of the end of the person's last membership, the end of their last admin place and the end
 *   of one that retention deleted (`person.last_admin_place_end`), or their creation when there is none (`lastActivityEnd`,
 *   specs 0021 and 0026).
 * - `SemesterEnd`: the end of the semester that two columns of the row hold (a term and a year).
 * - `PeriodEnd`: the end of the admission period that a column of the row refers to.
 * - `FiscalYearEnd`: the end of the calendar year of a date column (the association's fiscal year).
 */
export const Trigger = Schema.TaggedUnion({
  Column: { column: Schema.String, event: Words },
  FiscalYearEnd: { column: Schema.String },
  LastActivityEnd: {},
  PeriodEnd: { column: Schema.String },
  SemesterEnd: { term: Schema.String, year: Schema.String },
});

export type Trigger = typeof Trigger.Type;

/** What an anonymised column holds afterwards. */
export const Anonymised = Schema.TaggedUnion({
  Flag: { value: Schema.Boolean },
  Null: {},
  /** The row's id between a prefix and a suffix: a unique placeholder (an e-mail address that is never real). */
  PerRow: { prefix: Schema.String, suffix: Schema.String },
  Text: { value: Schema.String },
});

export type Anonymised = typeof Anonymised.Type;

/** What the nightly job does when the period has passed. */
export const OnExpiry = Schema.TaggedUnion({
  Anonymise: { to: Anonymised },
  Delete: {},
});

export type OnExpiry = typeof OnExpiry.Type;

export const Retention = Schema.Struct({
  /** A longer period while the person's consent of this kind is current (given and not withdrawn). */
  longerWhile: Schema.optionalKey(
    Schema.Struct({ consent: ConsentKind, period: Period })
  ),
  period: Period,
  trigger: Trigger,
});

export type Retention = typeof Retention.Type;

/** What is declared about one stored column. */
export const Classification = Schema.TaggedUnion({
  NotPersonal: { reason: Schema.String },
  PersonalData: {
    legalBasis: LegalBasis,
    onExpiry: OnExpiry,
    purpose: Purpose,
    retention: Retention,
  },
});

export type Classification = typeof Classification.Type;

export type PersonalData = Extract<
  Classification,
  { readonly _tag: "PersonalData" }
>;

export const personal = (fields: {
  readonly legalBasis: LegalBasis;
  readonly onExpiry: OnExpiry;
  readonly purpose: Purpose;
  readonly retention: Retention;
}): PersonalData => Classification.cases.PersonalData.make(fields);

export const notPersonal = (reason: string): Classification =>
  Classification.cases.NotPersonal.make({ reason });

/** How a row relates to a person: the column that holds the person's id, or one hop through a parent table. */
export const PersonKey = Schema.TaggedUnion({
  /**
   * The person's addresses appear in the row: a column that is an address, or the named members of a jsonb column
   * (`payload ->> 'to'`). The row is the person's by what it says, not by an id.
   */
  Address: { column: Schema.String, paths: Schema.Array(Schema.String) },
  Direct: { column: Schema.String },
  /** `column` refers to `parentKey` of `parent`, a table that has a key of its own. */
  Via: {
    column: Schema.String,
    parent: Schema.String,
    parentKey: Schema.String,
  },
});

export type PersonKey = typeof PersonKey.Type;

/** What the export does with a table whose rows are the person's. */
export const ExportRule = Schema.TaggedUnion({
  /** The table's rows are not exported, and why. */
  Excluded: { reason: Schema.String },
  /** The person's rows, without the named columns (each with its reason). */
  Rows: { exclude: Schema.Record(Schema.String, Schema.String) },
});

export type ExportRule = typeof ExportRule.Type;

/** What erasure does with a table whose rows are the person's. */
export const EraseRule = Schema.TaggedUnion({
  /** Run the declared `onExpiry` now, for this person. */
  Expire: {},
  /** The rows stay, and why (a history that the law lets the association keep, a legal hold). */
  Kept: { reason: Schema.String },
});

export type EraseRule = typeof EraseRule.Type;

/** What a merge does with the rows that refer to the merged person, per column. */
export const MergeRule = Schema.TaggedUnion({
  /** The merged person's rows are deleted: they belong to a record that no longer exists (a credential). */
  Drop: {},
  /**
   * Per `by`, the row with the earlier `madeAt` is the one that stays, and it moves if it was the merged person's; of two
   * rows made at the same time the survivor's stays. The later one is dropped (an application: the one made first stands).
   */
  Earliest: { by: Schema.String, madeAt: Schema.String },
  /** A reference that carries no lock: the column is rewritten to name the survivor. */
  Follow: {},
  /**
   * The table holds one row per person, keyed by the person's id: the survivor's row stays, and a survivor with none
   * takes the merged person's. A fact that either record had is kept, once.
   */
  Inherit: {},
  /**
   * The rows move to the survivor. A moved row that would collide with one the survivor has (on `collisions`, the
   * other columns of a unique key) is dropped, and the survivor's row stays; a constraint that no key names (the
   * overlap of two memberships in one team) refuses the merge with `refusal`, a text for the person who asked.
   */
  Move: { collisions: Schema.Array(Schema.String), refusal: Schema.String },
  /** Per `by`, the row with the later `decidedAt` is the one that stays, and it moves if it was the merged person's. */
  Newest: { by: Schema.String, decidedAt: Schema.String },
  /** At most one of the two people has a row; if both have, the merge is refused with `message`. */
  Single: { message: Schema.String },
  /** The reference stays and names the tombstone, and why. */
  Stay: { reason: Schema.String },
});

export type MergeRule = typeof MergeRule.Type;

export const PersonRelation = Schema.Struct({
  erase: EraseRule,
  export: ExportRule,
  key: PersonKey,
  /** Every column that holds a person's id, with what a merge does with it. */
  references: Schema.Record(Schema.String, MergeRule),
});

export type PersonRelation = typeof PersonRelation.Type;

/**
 * What retention keeps of a row that it deletes (spec 0026): before rows of the table are deleted, the greatest `from`
 * (an instant column of the row) of the rows about to go is folded into `into` (a column of the owner's row: the person's)
 * as the greater of that and what it holds. A merge folds the merged person's `into` into the survivor's the same way.
 */
export const Keeps = Schema.Struct({
  from: Schema.String,
  into: Schema.String,
});

export type Keeps = typeof Keeps.Type;

export const TableDeclaration = Schema.Struct({
  /** The column that says a row was anonymised; a table whose columns are anonymised names it. */
  anonymisedMarker: Schema.optionalKey(Schema.String),
  columns: Schema.Record(Schema.String, Classification),
  /** The date that retention keeps on the person when it deletes a row of this table. */
  keeps: Schema.optionalKey(Keeps),
  /** `null`: the rows are not about a person (a department, a semester). */
  person: Schema.NullOr(PersonRelation),
});

export type TableDeclaration = typeof TableDeclaration.Type;

export const table = (declaration: {
  readonly anonymisedMarker?: string;
  readonly columns: Readonly<Record<string, Classification>>;
  readonly keeps?: Keeps;
  readonly person: PersonRelation | null;
}): TableDeclaration => TableDeclaration.make(declaration);

export const relation = (fields: {
  readonly erase: EraseRule;
  readonly export: ExportRule;
  readonly key: PersonKey;
  readonly references: Readonly<Record<string, MergeRule>>;
}): PersonRelation => PersonRelation.make(fields);

/** The same classification for several columns. */
export const columns = (
  classification: Classification,
  names: readonly string[]
): Readonly<Record<string, Classification>> =>
  Rec.fromEntries(Arr.map(names, (name) => [name, classification] as const));

/**
 * What the address of an anonymised person looks like: `anonymisert-<id>@vektorprogrammet.invalid`. RFC 2606 reserves
 * `.invalid` so that it never resolves, so an address like this cannot receive mail, and nothing is sent to it.
 */
export const ANONYMISED_EMAIL = {
  prefix: "anonymisert-",
  suffix: "@vektorprogrammet.invalid",
} as const;

/** Whether an address is one that anonymisation wrote: the person it names has been erased. */
export const isAnonymisedEmail = (address: string): boolean =>
  address.endsWith(ANONYMISED_EMAIL.suffix);

/** What a merge says when a constraint refuses a moved row and the rule names no text of its own. */
export const MERGE_REFUSED =
  "Sammenslåingen strider mot en regel i databasen. Ingenting er endret.";

/** A fixed set of `MergeRule`, `ExportRule`, `EraseRule` and `PersonKey` values, so a table's declaration reads at a glance. */
export const Rules = {
  Anonymise: {
    flag: (value: boolean): OnExpiry =>
      OnExpiry.cases.Anonymise.make({
        to: Anonymised.cases.Flag.make({ value }),
      }),
    null: OnExpiry.cases.Anonymise.make({ to: Anonymised.cases.Null.make({}) }),
    perRow: (prefix: string, suffix: string): OnExpiry =>
      OnExpiry.cases.Anonymise.make({
        to: Anonymised.cases.PerRow.make({ prefix, suffix }),
      }),
    text: (value: string): OnExpiry =>
      OnExpiry.cases.Anonymise.make({
        to: Anonymised.cases.Text.make({ value }),
      }),
  },
  Delete: OnExpiry.cases.Delete.make({}),
  Drop: MergeRule.cases.Drop.make({}),
  Earliest: (by: string, madeAt: string): MergeRule =>
    MergeRule.cases.Earliest.make({ by, madeAt }),
  Follow: MergeRule.cases.Follow.make({}),
  Inherit: MergeRule.cases.Inherit.make({}),
  Move: (
    collisions: readonly string[] = [],
    refusal: string = MERGE_REFUSED
  ): MergeRule => MergeRule.cases.Move.make({ collisions, refusal }),
  Newest: (by: string, decidedAt: string): MergeRule =>
    MergeRule.cases.Newest.make({ by, decidedAt }),
  Single: (message: string): MergeRule =>
    MergeRule.cases.Single.make({ message }),
  Stay: (reason: string): MergeRule => MergeRule.cases.Stay.make({ reason }),
} as const;

export const keyed = {
  address: (column: string, paths: readonly string[] = []): PersonKey =>
    PersonKey.cases.Address.make({ column, paths }),
  direct: (column: string): PersonKey =>
    PersonKey.cases.Direct.make({ column }),
  via: (column: string, parent: string, parentKey: string): PersonKey =>
    PersonKey.cases.Via.make({ column, parent, parentKey }),
} as const;

export const exported = {
  excluded: (reason: string): ExportRule =>
    ExportRule.cases.Excluded.make({ reason }),
  rows: (exclude: Readonly<Record<string, string>> = {}): ExportRule =>
    ExportRule.cases.Rows.make({ exclude }),
} as const;

export const erased = {
  expire: EraseRule.cases.Expire.make({}),
  kept: (reason: string): EraseRule => EraseRule.cases.Kept.make({ reason }),
} as const;

/**
 * The relation of a table whose rows each name one person in `column`, which is nearly every table: the rows are
 * exported as they are (unless `exportRule` says otherwise), erased by expiring them (unless `eraseRule` says
 * otherwise), and merged by `rule`.
 */
export const ofPerson = (
  column: string,
  rule: MergeRule,
  exportRule: ExportRule = exported.rows(),
  eraseRule: EraseRule = erased.expire
): PersonRelation =>
  relation({
    erase: eraseRule,
    export: exportRule,
    key: keyed.direct(column),
    references: { [column]: rule },
  });

export const starts = {
  column: (column: string, event: Words): Trigger =>
    Trigger.cases.Column.make({ column, event }),
  fiscalYearEnd: (column: string): Trigger =>
    Trigger.cases.FiscalYearEnd.make({ column }),
  lastActivityEnd: Trigger.cases.LastActivityEnd.make({}),
  periodEnd: (column: string): Trigger =>
    Trigger.cases.PeriodEnd.make({ column }),
  semesterEnd: (term: string, year: string): Trigger =>
    Trigger.cases.SemesterEnd.make({ term, year }),
} as const;
