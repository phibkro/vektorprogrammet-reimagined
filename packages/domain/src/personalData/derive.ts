/**
 * Pure readings of the catalog (spec 0007b): the retention rules that the nightly job and the erasure compile, the words
 * that the notice and the record of processing print, and the checks of the catalog's own consistency. Nothing here
 * reads a database; `packages/db` interprets the rules, and a test closes the catalog over the migrated schema.
 */
import {
  Array as Arr,
  Order,
  Predicate,
  Record as Rec,
  String as Str,
} from "effect";

import type { CatalogOf } from "./catalog.ts";
import { MergeRule, OnExpiry, Trigger } from "./declaration.ts";
import type {
  Anonymised,
  PersonKey,
  PersonalData,
  Retention,
  TableDeclaration,
  Words,
} from "./declaration.ts";
import { durationWords } from "./duration.ts";
import type { Language } from "./duration.ts";
import type { FormDeclaration } from "./forms.ts";
import { approvalWords, consentNames } from "./texts.ts";

// ------------------------------------------------------------------ the columns

/** The personal columns of a table, with what is declared about each. */
export const personalColumns = (
  declaration: TableDeclaration
): readonly (readonly [string, PersonalData])[] =>
  Arr.flatMap(Rec.toEntries(declaration.columns), ([name, classification]) =>
    Predicate.isTagged(classification, "PersonalData")
      ? [[name, classification] as const]
      : []
  );

/** Every column of the catalog, by table. */
export const catalogColumns = (catalog: CatalogOf) =>
  Arr.flatMap(Rec.toEntries(catalog), ([table, declaration]) =>
    Arr.map(Rec.keys(declaration.columns), (column) => ({ column, table }))
  );

// ------------------------------------------------------------------ retention rules

/**
 * One rule of the retention job: the personal columns of a table that share a retention and an expiry kind. A `Delete`
 * rule removes the row. An `Anonymise` rule sets each of its columns to what that column declares (`anonymised`) and
 * stamps the table's marker, in one statement, so that a row is never left half anonymised.
 */
export interface RetentionRule {
  readonly table: string;
  readonly columns: readonly string[];
  readonly retention: Retention;
  readonly expiry: OnExpiry["_tag"];
  /** For `Anonymise`: what each column holds afterwards. */
  readonly anonymised: Readonly<Record<string, Anonymised>>;
  readonly marker: string | undefined;
  readonly key: PersonKey | null;
}

/** A rule's name in tests and in reports: its table and its columns. */
export const ruleId = (rule: RetentionRule): string =>
  `${rule.table}(${Arr.join(rule.columns, ",")})`;

const rulesOfTable = (
  table: string,
  declaration: TableDeclaration
): readonly RetentionRule[] => {
  const groups = Arr.groupBy(personalColumns(declaration), ([, data]) =>
    JSON.stringify([data.retention, data.onExpiry._tag])
  );

  return Arr.map(Rec.values(groups), (members) => {
    const [[, first]] = members;

    return {
      anonymised: Rec.fromEntries(
        Arr.flatMap(members, ([name, data]) =>
          Predicate.isTagged(data.onExpiry, "Anonymise")
            ? [[name, data.onExpiry.to] as const]
            : []
        )
      ),
      columns: Arr.sort(
        Arr.map(members, ([name]) => name),
        Order.String
      ),
      expiry: first.onExpiry._tag,
      key: declaration.person?.key ?? null,
      marker: declaration.anonymisedMarker,
      retention: first.retention,
      table,
    };
  });
};

/** Every retention rule of the catalog, in a stable order. */
export const retentionRules = (catalog: CatalogOf): readonly RetentionRule[] =>
  Arr.sort(
    Arr.flatMap(Rec.toEntries(catalog), ([table, declaration]) =>
      rulesOfTable(table, declaration)
    ),
    Order.mapInput(Order.String, ruleId)
  );

// ------------------------------------------------------------------ words

export const triggerWords = (trigger: Trigger, language: Language): string =>
  Trigger.match(trigger, {
    Column: ({ event }) => event[language],
    FiscalYearEnd: () =>
      language === "no" ? "regnskapsåret er slutt" : "the fiscal year ends",
    LastActivityEnd: () =>
      language === "no"
        ? "personens siste engasjement eller søknad er avsluttet"
        : "the person's last engagement or application ends",
    PeriodEnd: () =>
      language === "no"
        ? "opptaksperioden er slutt"
        : "the admission period ends",
    SemesterEnd: () =>
      language === "no" ? "semesteret er slutt" : "the term ends",
  });

/** "N days after the message was queued", or "when the session expires" for a period of nothing. */
const afterWords = (
  retention: Pick<Retention, "period" | "trigger">,
  language: Language
): string => {
  const event = triggerWords(retention.trigger, language);

  if (retention.period.duration.count === 0) {
    return language === "no" ? `når ${event}` : `when ${event}`;
  }

  const span = durationWords(retention.period.duration, language);

  return language === "no"
    ? `${span} etter at ${event}`
    : `${span} after ${event}`;
};

/** The periods that a retention applies: its own, and the longer one that a consent gives. */
const periodsOf = (retention: Retention) => [
  retention.period,
  ...(retention.longerWhile === undefined
    ? []
    : [retention.longerWhile.period]),
];

/**
 * Whether a retention rests on a proposal: a period that it applies is not decided yet. The notice, the record of
 * processing and the nightly run's gate (spec 0007b R4) all ask this one question.
 */
export const retentionIsProposed = (retention: Retention): boolean =>
  Arr.some(periodsOf(retention), ({ approval }) => approval === "proposed");

const approvalNotes = (retention: Retention, language: Language) =>
  Arr.dedupe(
    Arr.flatMap(periodsOf(retention), ({ approval }) => {
      const note = approvalWords[approval]?.[language];

      return note === undefined ? [] : [note];
    })
  );

const longerWords = (
  longerWhile: NonNullable<Retention["longerWhile"]>,
  language: Language
): string => {
  const span = durationWords(longerWhile.period.duration, language);
  const consent = consentNames[longerWhile.consent][language];

  return language === "no"
    ? `${span} så lenge samtykket «${consent}» er gitt`
    : `${span} while the “${consent}” consent is current`;
};

/**
 * The retention as a sentence: the period after its event, the longer period with its consent, and (unless `withNotes`
 * is false) a note for each proposal that waits for the operator's approval.
 */
export const retentionWords = (
  retention: Retention,
  language: Language,
  withNotes = true
): string => {
  const base = afterWords(retention, language);

  const sentence =
    retention.longerWhile === undefined
      ? base
      : `${base}, ${longerWords(retention.longerWhile, language)}`;

  const notes = approvalNotes(retention, language);

  return withNotes && Arr.isReadonlyArrayNonEmpty(notes)
    ? `${sentence} (${Arr.join(notes, "; ")})`
    : sentence;
};

/** What happens when the period has passed. */
export const expiryWords = (onExpiry: OnExpiry, language: Language): string =>
  OnExpiry.match(onExpiry, {
    Anonymise: () => (language === "no" ? "anonymiseres" : "anonymised"),
    Delete: () => (language === "no" ? "slettes" : "deleted"),
  });

// ------------------------------------------------------------------ the checks of the catalog

const blank = (text: string): boolean => Str.trim(text) === "";

const hasColumn = (declaration: TableDeclaration, column: string): boolean =>
  Rec.has(declaration.columns, column);

const missingColumns = (
  where: string,
  declaration: TableDeclaration,
  columns: readonly string[]
): readonly string[] =>
  Arr.flatMap(columns, (column) =>
    hasColumn(declaration, column)
      ? []
      : [
          `${where} names the column \`${column}\`, which the table does not declare`,
        ]
  );

const triggerColumns = (trigger: Trigger): readonly string[] =>
  Trigger.match(trigger, {
    Column: ({ column }) => [column],
    FiscalYearEnd: ({ column }) => [column],
    LastActivityEnd: () => [],
    PeriodEnd: ({ column }) => [column],
    SemesterEnd: ({ term, year }) => [term, year],
  });

/** Whether a table that starts a period at the last activity end can say which person a row belongs to. */
const lacksPerson = (declaration: TableDeclaration): boolean =>
  declaration.person === null ||
  Predicate.isTagged(declaration.person.key, "Address");

/**
 * Whether an anonymisation sets the column that says whose the row is to nothing. Once cleared the row is no longer the
 * person's, so a rule that runs again does not find it, and the table needs no marker for that.
 */
const clearsItsOwnKey = (
  declaration: TableDeclaration,
  column: string,
  onExpiry: OnExpiry
): boolean => {
  const key = declaration.person?.key;

  return (
    Predicate.isTagged(onExpiry, "Anonymise") &&
    Predicate.isTagged(onExpiry.to, "Null") &&
    Predicate.isTagged(key, "Direct") &&
    key.column === column
  );
};

const classificationProblems = (
  table: string,
  declaration: TableDeclaration
): readonly string[] =>
  Arr.flatMap(
    Rec.toEntries(declaration.columns),
    ([column, classification]) => {
      const where = `${table}.${column}`;

      if (Predicate.isTagged(classification, "NotPersonal")) {
        return blank(classification.reason)
          ? [`${where} is NotPersonal without a reason`]
          : [];
      }

      const { onExpiry, retention } = classification;

      return [
        ...missingColumns(
          `${where}'s retention`,
          declaration,
          triggerColumns(retention.trigger)
        ),
        ...(Predicate.isTagged(retention.trigger, "LastActivityEnd") &&
        lacksPerson(declaration)
          ? [
              `${where} starts at the last activity end, and ${table} has no person to take it from`,
            ]
          : []),
        ...(Predicate.isTagged(onExpiry, "Anonymise") &&
        !clearsItsOwnKey(declaration, column, onExpiry) &&
        (declaration.anonymisedMarker === undefined ||
          !hasColumn(declaration, declaration.anonymisedMarker))
          ? [
              `${where} is anonymised, and ${table} declares no marker column for it`,
            ]
          : []),
      ];
    }
  );

const keyProblems = (
  table: string,
  declaration: TableDeclaration,
  catalog: CatalogOf
): readonly string[] => {
  const key = declaration.person?.key;

  if (key === undefined) {
    return [];
  }

  if (!Predicate.isTagged(key, "Via")) {
    return missingColumns(`${table}'s key`, declaration, [key.column]);
  }

  const parentKey = catalog[key.parent]?.person?.key;

  return [
    ...missingColumns(`${table}'s key`, declaration, [key.column]),
    ...(Predicate.isTagged(parentKey, "Direct")
      ? []
      : [
          `${table}'s key goes through ${key.parent}, which has no direct person key`,
        ]),
  ];
};

const mergeColumns = (rule: MergeRule): readonly string[] =>
  MergeRule.match(rule, {
    Drop: () => [],
    Follow: () => [],
    Inherit: () => [],
    Move: ({ collisions }) => collisions,
    Newest: ({ by, decidedAt }) => [by, decidedAt],
    Single: () => [],
    Stay: () => [],
  });

const relationReasons = (
  person: NonNullable<TableDeclaration["person"]>
): readonly string[] => [
  ...(Predicate.isTagged(person.erase, "Kept") ? [person.erase.reason] : []),
  ...(Predicate.isTagged(person.export, "Excluded")
    ? [person.export.reason]
    : Rec.values(person.export.exclude)),
  ...Arr.flatMap(Rec.values(person.references), (rule) =>
    Predicate.isTagged(rule, "Stay") ? [rule.reason] : []
  ),
];

const relationProblems = (
  table: string,
  declaration: TableDeclaration,
  catalog: CatalogOf
): readonly string[] => {
  const { person } = declaration;

  if (person === null) {
    return [];
  }

  return [
    ...keyProblems(table, declaration, catalog),
    ...missingColumns(
      `${table}'s references`,
      declaration,
      Rec.keys(person.references)
    ),
    ...Arr.flatMap(Rec.toEntries(person.references), ([column, rule]) =>
      missingColumns(
        `${table}.${column}'s merge rule`,
        declaration,
        mergeColumns(rule)
      )
    ),
    ...(Predicate.isTagged(person.export, "Rows")
      ? missingColumns(
          `${table}'s export`,
          declaration,
          Rec.keys(person.export.exclude)
        )
      : []),
    ...(Arr.some(relationReasons(person), blank)
      ? [`${table} declares an exclusion, a keep or a stay without a reason`]
      : []),
    ...(Predicate.isTagged(person.erase, "Expire") &&
    personalColumns(declaration).length === 0
      ? [
          `${table} is erased by expiring its rows, and declares no personal column to expire`,
        ]
      : []),
  ];
};

const fieldProblems = (
  form: FormDeclaration,
  catalog: CatalogOf,
  name: string,
  field: FormDeclaration["fields"][string]
): readonly string[] => {
  if (!Predicate.isTagged(field, "Collected")) {
    return blank(field.reason)
      ? [
          `the ${form.form} form's field ${name} is NotPersonal without a reason`,
        ]
      : [];
  }

  const [tableName, columnName = ""] = Str.split(field.storedIn, ".");
  const stored = catalog[tableName]?.columns[columnName];

  return Predicate.isTagged(stored, "PersonalData")
    ? []
    : [
        `the ${form.form} form's field ${name} is stored in ${field.storedIn}, which the catalog does not declare as personal`,
      ];
};

const formProblems = (
  form: FormDeclaration,
  catalog: CatalogOf
): readonly string[] => {
  const declared = Rec.keys(form.fields);

  return [
    ...Arr.flatMap(form.schemaFields, (name) =>
      Arr.contains(declared, name)
        ? []
        : [`the ${form.form} form's field ${name} has no declaration`]
    ),
    ...Arr.flatMap(declared, (name) =>
      Arr.contains(form.schemaFields, name)
        ? []
        : [
            `the ${form.form} form declares ${name}, which its schema does not have`,
          ]
    ),
    ...Arr.flatMap(Rec.toEntries(form.fields), ([name, field]) =>
      fieldProblems(form, catalog, name, field)
    ),
  ];
};

/** Everything inconsistent in a catalog and its forms, apart from the schema it is closed over. Empty means consistent. */
export const catalogProblems = (
  catalog: CatalogOf,
  forms: readonly FormDeclaration[]
): readonly string[] => [
  ...Arr.flatMap(Rec.toEntries(catalog), ([table, declaration]) => [
    ...(Rec.size(declaration.columns) === 0
      ? [`${table} declares no column`]
      : []),
    ...(declaration.anonymisedMarker === undefined ||
    hasColumn(declaration, declaration.anonymisedMarker)
      ? []
      : [
          `${table}'s marker ${declaration.anonymisedMarker} is not a declared column`,
        ]),
    ...classificationProblems(table, declaration),
    ...relationProblems(table, declaration, catalog),
  ]),
  ...Arr.flatMap(forms, (form) => formProblems(form, catalog)),
];

// ------------------------------------------------------------------ what the other readings need

/** A column that refers to a person, with the merge rule it has. */
export interface PersonReference {
  readonly column: string;
  readonly rule: MergeRule;
  readonly table: string;
}

/** Every column, in every table, that refers to a person. */
export const personReferences = (
  catalog: CatalogOf
): readonly PersonReference[] =>
  Arr.flatMap(Rec.toEntries(catalog), ([table, declaration]) =>
    Arr.map(
      Rec.toEntries(declaration.person?.references ?? {}),
      ([column, rule]) => ({ column, rule, table })
    )
  );

/** The tables whose rows the export returns, with the columns it leaves out. */
export const exportedTables = (catalog: CatalogOf) =>
  Arr.flatMap(Rec.toEntries(catalog), ([table, declaration]) =>
    declaration.person !== null &&
    Predicate.isTagged(declaration.person.export, "Rows")
      ? [
          {
            exclude: declaration.person.export.exclude,
            key: declaration.person.key,
            table,
          },
        ]
      : []
  );

/** The tables that hold the person's data and that the export leaves out, with the reason. */
export const excludedTables = (catalog: CatalogOf) =>
  Arr.flatMap(Rec.toEntries(catalog), ([table, declaration]) =>
    declaration.person !== null &&
    Predicate.isTagged(declaration.person.export, "Excluded")
      ? [{ reason: declaration.person.export.reason, table }]
      : []
  );

/** The words of a retention in both languages, for the places that print both. */
export const retentionWordsBoth = (
  retention: Retention,
  withNotes: boolean
): Words => ({
  en: retentionWords(retention, "en", withNotes),
  no: retentionWords(retention, "no", withNotes),
});
