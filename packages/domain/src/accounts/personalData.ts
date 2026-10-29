/**
 * What the accounts domain declares about its stored columns (spec 0007b): the account, the codes, the four Better
 * Auth tables and the non-production mailbox and Slack.
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
} from "../personalData/declaration.ts";
import { Periods } from "../personalData/periods.ts";
import { afterColumn, withThePersonCore } from "../personalData/retentions.ts";

const SECRET =
  "A credential: a copy in a file that the person downloads would be a secret kept in the wrong place";

const ONE_ACCOUNT =
  "Begge personene har en konto, og en person kan bare ha én. De kan ikke slås sammen.";

const BETTER_AUTH_KEY = "A random key that Better Auth makes";

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

const authUser = table({
  columns: {
    ...columns(login(withThePersonCore), [
      "created_at",
      "email",
      "email_verified",
      "image",
      "name",
      "person_id",
      "updated_at",
    ]),
    id: notPersonal(BETTER_AUTH_KEY),
  },
  person: ofPerson("person_id", Rules.Single(ONE_ACCOUNT)),
});

const sessionRetention = afterColumn("expires_at", Periods.sessionExpiry, {
  en: "the session expires",
  no: "økten utløper",
});

const authSession = table({
  columns: {
    ...columns(login(sessionRetention), [
      "created_at",
      "expires_at",
      "ip_address",
      "token",
      "updated_at",
      "user_agent",
      "user_id",
    ]),
    id: notPersonal(BETTER_AUTH_KEY),
  },
  person: relation({
    erase: erased.expire,
    export: exported.rows({ token: SECRET }),
    key: keyed.via("user_id", "auth_user", "id"),
    references: {},
  }),
});

const authAccount = table({
  columns: {
    ...columns(login(withThePersonCore), [
      "access_token",
      "access_token_expires_at",
      "account_id",
      "created_at",
      "credential_version",
      "id_token",
      "password",
      "provider_id",
      "refresh_token",
      "refresh_token_expires_at",
      "scope",
      "updated_at",
      "user_id",
    ]),
    id: notPersonal(BETTER_AUTH_KEY),
  },
  person: relation({
    erase: erased.expire,
    export: exported.rows({
      access_token: SECRET,
      id_token: SECRET,
      password: SECRET,
      refresh_token: SECRET,
    }),
    key: keyed.via("user_id", "auth_user", "id"),
    references: {},
  }),
});

/** Better Auth's one-time tokens: the library keeps the address in `identifier`. No flow of ours writes this table. */
const authVerification = table({
  columns: {
    ...columns(login(sessionRetention), [
      "created_at",
      "expires_at",
      "identifier",
      "updated_at",
      "value",
    ]),
    id: notPersonal(BETTER_AUTH_KEY),
  },
  person: null,
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
  auth_account: authAccount,
  auth_session: authSession,
  auth_user: authUser,
  auth_verification: authVerification,
  captured_mail: capturedMail,
  captured_slack: capturedSlack,
  code,
} as const;
