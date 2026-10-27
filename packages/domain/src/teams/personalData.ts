/**
 * What the teams domain declares about its stored columns (spec 0007b): the person, the memberships, the admin places,
 * the digest ledger, the teams and the position list. The catalog (`personalData/catalog.ts`) gathers every domain's
 * tables; a test closes it over the migrated schema.
 */
import {
  ANONYMISED_EMAIL,
  Retention,
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
  Rules,
} from "../personalData/declaration.ts";
import { durationWords } from "../personalData/duration.ts";
import { Periods } from "../personalData/periods.ts";
import { afterColumn, withThePersonCore } from "../personalData/retentions.ts";

const NOT_ABOUT_A_PERSON =
  "A team or a position of the organisation: it names no person";

const SURROGATE = "A surrogate key; it names no one on its own";

/** Who was a member or assistant, where and when: for the period of `Periods.engagementHistory` after the term ends. */
const engagementHistory: Retention = Retention.make({
  period: Periods.engagementHistory,
  trigger: starts.semesterEnd("end_term", "end_year"),
});

const person = table({
  anonymisedMarker: "anonymised_at",
  columns: {
    anonymised_at: notPersonal(
      "A marker that the core fields were anonymised, and when; it holds no value about the person"
    ),
    company_email: personal({
      legalBasis: "contract",
      onExpiry: Rules.Anonymise.null,
      purpose: "engagements",
      retention: withThePersonCore,
    }),
    created_at: notPersonal(
      "When the record was made. It starts the period of a person with no engagement, and says nothing about the person once the name and the addresses are gone"
    ),
    email: personal({
      legalBasis: "contract",
      onExpiry: Rules.Anonymise.perRow(
        ANONYMISED_EMAIL.prefix,
        ANONYMISED_EMAIL.suffix
      ),
      purpose: "engagements",
      retention: withThePersonCore,
    }),
    email_verified: personal({
      legalBasis: "contract",
      onExpiry: Rules.Anonymise.flag(false),
      purpose: "engagements",
      retention: withThePersonCore,
    }),
    field_of_study_id: notPersonal(
      "A course of study from a list that hundreds of people share. It identifies no one without the name, and it gives a historical membership its department"
    ),
    id: notPersonal(
      "A surrogate key; the history rows keep naming it, and it names no one once the core fields are anonymised"
    ),
    merged_into: notPersonal(
      "The surviving record of a merge; nothing reads the pointer except the merge itself"
    ),
    name: personal({
      legalBasis: "contract",
      onExpiry: Rules.Anonymise.text("Anonymisert"),
      purpose: "engagements",
      retention: withThePersonCore,
    }),
    photo_key: personal({
      legalBasis: "consent",
      onExpiry: Rules.Anonymise.null,
      purpose: "photo",
      retention: withThePersonCore,
    }),
  },
  person: relation({
    erase: erased.expire,
    export: exported.rows(),
    key: keyed.direct("id"),
    references: {
      merged_into: Rules.Stay(
        "A tombstone names its survivor. A tombstone that is itself merged later keeps pointing at the record it was merged into, which is a tombstone too; the survivor of a chain is found by following it"
      ),
    },
  }),
});

const membership = table({
  columns: {
    ...columns(
      personal({
        legalBasis: "legitimateInterest",
        onExpiry: Rules.Delete,
        purpose: "engagementHistory",
        retention: engagementHistory,
      }),
      [
        "end_ordinal",
        "end_term",
        "end_year",
        "leader",
        "person_id",
        "position_id",
        "start_ordinal",
        "start_term",
        "start_year",
        "team_id",
      ]
    ),
    id: notPersonal(SURROGATE),
  },
  person: relation({
    erase: erased.kept(
      `The history of who was a member or assistant, where and when. The association may keep it without consent, as an employer keeps who was employed in which period (INFORMATION_MODEL §11.1), for ${durationWords(Periods.engagementHistory.duration, "en")}`
    ),
    export: exported.rows(),
    key: keyed.direct("person_id"),
    references: {
      person_id: Rules.Move(
        [],
        "To medlemskap i samme team overlapper i tid. Avslutt det ene først."
      ),
    },
  }),
});

const adminGrant = table({
  columns: {
    ...columns(
      personal({
        legalBasis: "legitimateInterest",
        onExpiry: Rules.Delete,
        purpose: "places",
        retention: afterColumn("until", Periods.adminPlaceAfterEnd, {
          en: "the place ends",
          no: "plassen utløper",
        }),
      }),
      ["granted_by", "person_id", "until"]
    ),
    id: notPersonal(SURROGATE),
  },
  person: relation({
    erase: erased.kept(
      `The record of who held a place on the admin list and who gave it, kept ${durationWords(Periods.adminPlaceAfterEnd.duration, "en")} after the place ends`
    ),
    export: exported.rows(),
    key: keyed.direct("person_id"),
    references: {
      granted_by: Rules.Stay(
        "The grant history keeps saying who granted a place; after a merge it names the tombstone, which is a person with no data"
      ),
      person_id: Rules.Move(
        [],
        "En administratorplass ville blitt gitt av personen selv. Fjern plassen først."
      ),
    },
  }),
});

const endingSoonDigest = table({
  columns: columns(
    personal({
      legalBasis: "legitimateInterest",
      onExpiry: Rules.Delete,
      purpose: "digest",
      retention: withThePersonCore,
    }),
    ["person_id", "recorded_at", "term", "year"]
  ),
  person: ofPerson("person_id", Rules.Move(["term", "year"])),
});

const adminList = table({
  columns: columns(
    notPersonal(
      "The one row that the admin list's lock is taken on (spec 0006b); it holds no data"
    ),
    ["id"]
  ),
  person: null,
});

const team = table({
  columns: columns(notPersonal(NOT_ABOUT_A_PERSON), [
    "active",
    "default_term",
    "department_id",
    "function",
    "group_email",
    "id",
    "name",
  ]),
  person: null,
});

const position = table({
  columns: columns(notPersonal(NOT_ABOUT_A_PERSON), ["id", "name"]),
  person: null,
});

/**
 * The claim of the first-membership welcome (spec 0008): one row per person, made in the transaction that creates the
 * person's first membership, so the welcome goes once. A merge keeps one claim for the survivor: the survivor's own, or
 * else the merged record's. The merged record may hold the only claim left (its one planned membership was cancelled),
 * and a survivor without it would be welcomed a second time.
 */
const welcomeLedger = table({
  columns: columns(
    personal({
      legalBasis: "legitimateInterest",
      onExpiry: Rules.Delete,
      purpose: "welcome",
      retention: withThePersonCore,
    }),
    ["person_id", "recorded_at"]
  ),
  person: ofPerson("person_id", Rules.Inherit),
});

export const TeamsTables = {
  admin_grant: adminGrant,
  admin_list: adminList,
  ending_soon_digest: endingSoonDigest,
  membership,
  person,
  position,
  team,
  welcome_ledger: welcomeLedger,
} as const;
