/**
 * Spec 0007b falsifier 1, the declaration half: the catalog of stored tables and the forms that collect are consistent
 * with themselves (`catalogProblems`), and each way of being inconsistent is found. The real catalog has no problem; a
 * small valid catalog is changed in one way at a time, and each change names the problem that it makes (the negative
 * controls). The closure over the migrated schema is `packages/db/test/personalDataClosure.postgres.test.ts`.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Schema } from "effect";

import { Catalog, Forms, catalogProblems } from "../../src/index.ts";
import type { CatalogOf, FormDeclaration } from "../../src/index.ts";
import {
  Retention,
  Rules,
  columns,
  erased,
  exported,
  keyed,
  notPersonal,
  ofPerson,
  personal,
  relation,
  starts,
  table,
} from "../../src/personalData/declaration.ts";
import type {
  Classification,
  EraseRule,
  ExportRule,
  MergeRule,
  OnExpiry,
  PersonKey,
  TableDeclaration,
} from "../../src/personalData/declaration.ts";
import { collected, form, notCollected } from "../../src/personalData/forms.ts";
import { Periods } from "../../src/personalData/periods.ts";

const WRITTEN = {
  en: "the note was written",
  no: "notatet ble skrevet",
};

const afterWriting = Retention.make({
  period: Periods.outboxRows,
  trigger: starts.column("created_at", WRITTEN),
});

/** What the note's text is, for the notice, the purpose and the legal basis: it varies in its retention and expiry. */
const written = (retention: Retention, onExpiry: OnExpiry = Rules.Delete) =>
  personal({
    legalBasis: "consent",
    onExpiry,
    purpose: "contact",
    retention,
  });

/** A table with a personal column, a key to the person, an export and an erasure: valid in every respect. */
const note: TableDeclaration = table({
  columns: {
    ...columns(notPersonal("A surrogate key, a time and a number"), [
      "created_at",
      "id",
    ]),
    person_id: personal({
      legalBasis: "contract",
      onExpiry: Rules.Delete,
      purpose: "engagements",
      retention: afterWriting,
    }),
    text: written(afterWriting),
  },
  person: ofPerson("person_id", Rules.Follow),
});

const valid: CatalogOf = { note };

/** The note with one column declared another way. */
const withColumn =
  (name: string, classification: Classification) =>
  (declaration: TableDeclaration): TableDeclaration => ({
    ...declaration,
    columns: { ...declaration.columns, [name]: classification },
  });

/** The parts of a relation to a person that a case changes. */
interface RelationParts {
  readonly erase: EraseRule;
  readonly export: ExportRule;
  readonly key: PersonKey;
  readonly references: Readonly<Record<string, MergeRule>>;
}

/** The note's relation to a person, with the parts that the case names changed. */
const withRelation =
  (changes: Partial<RelationParts>) =>
  (declaration: TableDeclaration): TableDeclaration => ({
    ...declaration,
    person: relation({
      erase: erased.expire,
      export: exported.rows(),
      key: keyed.direct("person_id"),
      references: { person_id: Rules.Follow },
      ...changes,
    }),
  });

const NoteForm = Schema.Struct({ text: Schema.String, topic: Schema.String });

/** What the note form says about its text, which the note stores in `storedIn`. */
const textStoredIn = (storedIn: string) =>
  collected({
    label: { en: "Your note", no: "Notatet ditt" },
    legalBasis: "consent",
    purpose: "contact",
    recipients: { en: "Nobody", no: "Ingen" },
    storedIn,
  });

const noteForm: FormDeclaration = form({
  fields: {
    text: textStoredIn("note.text"),
    topic: notCollected("The topic is the organisation's"),
  },
  form: "note",
  schema: NoteForm,
  title: { en: "Note form", no: "Notatskjema" },
});

/** The note form with other fields than it was declared with. */
const withFields = (
  fields: FormDeclaration["fields"],
  schemaFields: FormDeclaration["schemaFields"] = noteForm.schemaFields
): FormDeclaration => ({ ...noteForm, fields, schemaFields });

/** A change to the valid table, and the words that the problem it makes must contain. */
const tableCases: readonly (readonly [
  string,
  (declaration: TableDeclaration) => TableDeclaration,
  string,
])[] = [
  [
    "a table with no column",
    (declaration) => ({ ...declaration, columns: {} }),
    "note declares no column",
  ],
  [
    "a marker that is not a column",
    (declaration) => ({ ...declaration, anonymisedMarker: "anonymised_at" }),
    "marker anonymised_at is not a declared column",
  ],
  [
    "a column that is not personal and says nothing about why",
    withColumn("created_at", notPersonal("  ")),
    "note.created_at is NotPersonal without a reason",
  ],
  [
    "a retention that starts at a column the table does not have",
    withColumn(
      "text",
      written(
        Retention.make({
          period: Periods.outboxRows,
          trigger: starts.column("written_at", WRITTEN),
        })
      )
    ),
    "names the column `written_at`, which the table does not declare",
  ],
  [
    "a column that is anonymised, in a table with no marker to say so",
    withColumn("text", written(afterWriting, Rules.Anonymise.null)),
    "is anonymised, and note declares no marker column for it",
  ],
  [
    "a key that is not a column",
    withRelation({ key: keyed.direct("owner_id"), references: {} }),
    "note's key names the column `owner_id`, which the table does not declare",
  ],
  [
    "a key that goes through a parent that has no key of its own",
    withRelation({
      key: keyed.via("person_id", "folder", "id"),
      references: {},
    }),
    "goes through folder, which has no direct person key",
  ],
  [
    "a reference to a person in a column the table does not have",
    withRelation({
      references: { person_id: Rules.Follow, written_by: Rules.Follow },
    }),
    "note's references names the column `written_by`",
  ],
  [
    "a merge rule that names a column the table does not have",
    withRelation({
      references: { person_id: Rules.Newest("topic", "decided_at") },
    }),
    "note.person_id's merge rule names the column `topic`",
  ],
  [
    "an export that leaves out a column the table does not have",
    withRelation({ export: exported.rows({ secret: "A hash" }) }),
    "note's export names the column `secret`",
  ],
  [
    "an exclusion from the export that gives no reason",
    withRelation({ export: exported.excluded("") }),
    "note declares an exclusion, a keep or a stay without a reason",
  ],
  [
    "rows that stay after an erasure, and nobody says why",
    withRelation({ erase: erased.kept(" ") }),
    "declares an exclusion, a keep or a stay without a reason",
  ],
  [
    "an erasure that expires rows, in a table with no personal column to expire",
    (declaration) => ({
      ...declaration,
      columns: columns(notPersonal("Nothing about a person"), [
        "created_at",
        "id",
        "person_id",
      ]),
    }),
    "is erased by expiring its rows, and declares no personal column to expire",
  ],
  [
    "a period that starts at the last activity, in a table with no person to take it from",
    (declaration) => ({
      ...withColumn(
        "text",
        written(
          Retention.make({
            period: Periods.personCore,
            trigger: starts.lastActivityEnd,
          })
        )
      )(declaration),
      person: null,
    }),
    "starts at the last activity end, and note has no person to take it from",
  ],
];

const formCases: readonly (readonly [string, FormDeclaration, string])[] = [
  [
    "a form field that the schema has and the declaration does not",
    withFields(noteForm.fields, ["text", "topic", "phone"]),
    "the note form's field phone has no declaration",
  ],
  [
    "a declared field that the schema does not have",
    withFields(noteForm.fields, ["text"]),
    "the note form declares topic, which its schema does not have",
  ],
  [
    "a field that is not personal and says nothing about why",
    withFields({ ...noteForm.fields, topic: notCollected("") }),
    "the note form's field topic is NotPersonal without a reason",
  ],
  [
    "a field that is stored in a column that is not declared as personal",
    withFields({ ...noteForm.fields, text: textStoredIn("note.created_at") }),
    "the note form's field text is stored in note.created_at, which the catalog does not declare as personal",
  ],
];

/** Whether any problem of the catalog contains `expected`, and the problems when none does. */
const found = (problems: readonly string[], expected: string) => ({
  found: Arr.some(problems, (problem) => problem.includes(expected)),
  message: `${expected} in ${Arr.join(problems, "; ")}`,
});

describe("spec 0007b falsifier 1: the catalog is consistent", () => {
  it("the real catalog and the forms that collect have no problem", () => {
    assert.deepStrictEqual(catalogProblems(Catalog, Forms), []);
  });

  it("the small valid catalog and its form have no problem, so each case below is the change it makes", () => {
    assert.deepStrictEqual(catalogProblems(valid, [noteForm]), []);
  });

  for (const [name, change, expected] of tableCases) {
    it(`negative control: ${name} is found`, () => {
      const result = found(
        catalogProblems({ note: change(note) }, [noteForm]),
        expected
      );

      assert.isTrue(result.found, result.message);
    });
  }

  for (const [name, changed, expected] of formCases) {
    it(`negative control: ${name} is found`, () => {
      const result = found(catalogProblems(valid, [changed]), expected);

      assert.isTrue(result.found, result.message);
    });
  }
});
