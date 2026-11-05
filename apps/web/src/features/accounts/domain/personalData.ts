/**
 * The accounts domain declares its account, consent code and non-production mailbox storage.
 */
import {
  Rules,
  columns,
  erased,
  exported,
  keyed,
  notPersonal,
  ofPerson,
  personal,
  relation,
  table,
} from "../../personal-data/domain/declaration.ts";
import { Periods } from "../../personal-data/domain/periods.ts";
import {
  afterColumn,
  withThePersonCore,
} from "../../personal-data/domain/retentions.ts";

const SECRET =
  "A credential: a copy in a file that the person downloads would be a secret kept in the wrong place";

const ONE_ACCOUNT =
  "Begge personene har en konto, og en person kan bare ha én. De kan ikke slås sammen.";

const login = (retention: typeof withThePersonCore) =>
  personal({
    legalBasis: "contract",
    onExpiry: Rules.Delete,
    purpose: "login",
    retention,
  });

const account = table({
  columns: columns(login(withThePersonCore), ["person_id", "state"]),
  person: ofPerson("person_id", Rules.Single(ONE_ACCOUNT)),
});

const code = table({
  columns: columns(
    login(
      afterColumn("expires_at", Periods.codeAfterExpiry, {
        en: "the code expires",
        no: "koden utløper",
      })
    ),
    ["expires_at", "hash", "purpose", "state", "subject"]
  ),
  person: ofPerson("subject", Rules.Drop, exported.rows({ hash: SECRET })),
});

const capturedMail = table({
  columns: {
    ...columns(
      personal({
        legalBasis: "legitimateInterest",
        onExpiry: Rules.Delete,
        purpose: "mailbox",
        retention: afterColumn("sent_at", Periods.capturedMail, {
          en: "the mail was captured",
          no: "e-posten ble fanget",
        }),
      }),
      ["recipient", "sent_at", "subject", "text"]
    ),
    delivery_key: notPersonal(
      "The id of the outbox row that the capture records: a key that makes a delivery that is retried show once. It names a row, not a person"
    ),
    id: notPersonal("A surrogate key"),
  },
  person: relation({
    erase: erased.expire,
    export: exported.excluded(
      "A test mailbox of the non-production deployments: production never writes it, and what it holds is what the sender layer would have sent"
    ),
    key: keyed.address("recipient"),
    references: {},
  }),
});

/** The non-production Slack beside the mailbox (spec 0008): a post has a channel and a text, and no addressee. */
const capturedSlack = table({
  columns: {
    ...columns(
      personal({
        legalBasis: "legitimateInterest",
        onExpiry: Rules.Delete,
        purpose: "mailbox",
        retention: afterColumn("sent_at", Periods.capturedSlack, {
          en: "the post was captured",
          no: "innlegget ble fanget",
        }),
      }),
      ["channel", "sent_at", "text"]
    ),
    delivery_key: notPersonal(
      "The id of the outbox row that the capture records: a key that makes a delivery that is retried show once. It names a row, not a person"
    ),
    id: notPersonal("A surrogate key"),
  },
  person: null,
});

export const AccountTables = {
  account,
  captured_mail: capturedMail,
  captured_slack: capturedSlack,
  code,
} as const;
