/**
 * The words of the personal data declarations: the purposes, the legal bases, the consent texts and the privacy notice's
 * fixed paragraphs, in Norwegian (what a person reads) and English (the system documentation). The consent texts and the
 * notice are **proposed, awaiting operator approval** (spec 0007b R1 item 14): the privacy owner approves them before
 * go-live, and approving is a one-line change of `approval`. This is not legal advice (`INFORMATION_MODEL.md` §11).
 *
 * A period that a text states is built from `Periods` (`durationWords`), with one exception: a consent text. It is what
 * a person agrees to, and a record names its version, so its words must not change under a period without a new version
 * (retention reads a withdrawal, not the version a consent names). A consent text is written out, and
 * `test/personalData/periodsInText.test.ts` fails when a period it states is not the declared one (spec 0007b R3 item 28).
 */
import type {
  Approval,
  ConsentKind,
  LegalBasis,
  Purpose,
  Words,
} from "./declaration.ts";
import { durationWords } from "./duration.ts";
import { Periods } from "./periods.ts";

export type { Words } from "./declaration.ts";

export const purposes: Readonly<Record<Purpose, Words>> = {
  accountability: {
    en: "Show who did what and when, so that the organisation can account for its own use of the data (Art. 5(2) and 24)",
    no: "Vise hvem som gjorde hva og når, slik at organisasjonen kan gjøre rede for sin egen bruk av opplysningene",
  },
  alumni: {
    en: `Ask a person who leaves whether their details may be kept for ${durationWords(Periods.personCoreWithKeepDetails.duration, "en")} and whether to send alumni news`,
    no: `Spørre den som slutter om vi kan beholde opplysningene i ${durationWords(Periods.personCoreWithKeepDetails.duration, "no")} og sende nyheter til tidligere medlemmer`,
  },
  consents: {
    en: "Record what a person agreed to, which text they saw and when (Art. 7(1))",
    no: "Dokumentere hva en person har samtykket til, hvilken tekst som ble vist og når",
  },
  contact: {
    en: "Answer a question sent through the contact form",
    no: "Svare på en henvendelse sendt fra kontaktskjemaet",
  },
  delivery: {
    en: "Send the e-mail and Slack messages that the system makes",
    no: "Sende e-post og Slack-meldinger som systemet lager",
  },
  digest: {
    en: "Send each team leader one summary of the memberships that are about to end",
    no: "Sende hver teamleder én oppsummering av medlemskap som snart utløper",
  },
  engagementHistory: {
    en: "Keep the historical record of who was a member or assistant, where and when (certificates, references)",
    no: "Ta vare på historikken over hvem som var medlem eller assistent, hvor og når (attester, referanser)",
  },
  engagements: {
    en: "Know who is a member or assistant, where and when, and what each may do",
    no: "Vite hvem som er medlem eller assistent, hvor og når, og hva hver enkelt kan gjøre",
  },
  files: {
    en: "Show who published a public file",
    no: "Vise hvem som har publisert en offentlig fil",
  },
  login: {
    en: "Let a person sign in and keep them signed in",
    no: "La en person logge inn og holde dem innlogget",
  },
  mailbox: {
    en: "A test mailbox that the non-production deployments use instead of sending mail",
    no: "En testpostkasse som test- og utviklingsmiljøene bruker i stedet for å sende e-post",
  },
  photo: {
    en: "Show a member's photo, with their consent",
    no: "Vise bilde av et medlem, med samtykke",
  },
  places: {
    en: "Keep the record of who held a place on the admin list",
    no: "Ta vare på oversikten over hvem som har hatt en plass på administratorlisten",
  },
};

export interface LegalBasisText extends Words {
  /** The article, as the record of processing cites it. */
  readonly citation: string;
}

export const legalBases: Readonly<Record<LegalBasis, LegalBasisText>> = {
  consent: {
    citation: "Art. 6(1)(a)",
    en: "Consent",
    no: "Samtykke",
  },
  contract: {
    citation: "Art. 6(1)(b)",
    en: "Agreement with the person (taking part as a member or assistant)",
    no: "Avtale med personen (deltakelse som medlem eller assistent)",
  },
  explicitConsent: {
    citation: "Art. 9(2)(a)",
    en: "Explicit consent",
    no: "Uttrykkelig samtykke",
  },
  legalObligation: {
    citation: "Art. 6(1)(c)",
    en: "Legal obligation",
    no: "Rettslig forpliktelse",
  },
  legitimateInterest: {
    citation: "Art. 6(1)(f)",
    en: "Legitimate interest of the organisation",
    no: "Berettiget interesse hos organisasjonen",
  },
};

/**
 * Whether the privacy owner has approved the legal bases that the catalog declares, each with its purpose. The operator's
 * decisions of 2026-10-26 fix the periods and name no basis (`INFORMATION_MODEL.md` §11.3 heads its column "Purpose and
 * basis (proposal)"), and several of the bases are this slice's own choice (a consent record rests on a legal obligation,
 * a login on an agreement), so every basis is a proposal until this says `decided`. The record of processing marks each
 * basis while it is proposed, apart from the approval of each period, and approving is a one-line change here (spec 0007b
 * R3 item 32).
 */
export const basesApproval: Approval = "proposed";

/** One consent's declared text. A record names a version, and can name only the current one. */
export interface ConsentText extends Words {
  readonly approval: Approval;
  readonly version: number;
}

export const consentTexts: Readonly<Record<ConsentKind, ConsentText>> = {
  keepDetails: {
    approval: "proposed",
    en: "Yes, Vektorprogrammet may keep my details for 5 years after I leave, instead of 1 year. I can withdraw this at any time.",
    no: "Ja, Vektorprogrammet kan beholde kontaktopplysningene mine i 5 år etter at jeg har sluttet, i stedet for 1 år. Jeg kan trekke samtykket når som helst.",
    version: 1,
  },
  news: {
    approval: "proposed",
    en: "Yes, send me news for former members and assistants. I can withdraw this at any time.",
    no: "Ja, send meg nyheter for tidligere medlemmer og assistenter. Jeg kan trekke samtykket når som helst.",
    version: 1,
  },
  photo: {
    approval: "proposed",
    en: "Yes, Vektorprogrammet may store and show my photo to present me in my team. I can withdraw this at any time, and the photo is then removed.",
    no: "Ja, Vektorprogrammet kan lagre og vise bildet mitt for å presentere meg i teamet mitt. Jeg kan trekke samtykket når som helst, og bildet fjernes da.",
    version: 1,
  },
};

/** The fixed paragraphs of the privacy notice (the fields it lists come from the declarations). */
export interface PrivacyText {
  readonly approval: Approval;
  readonly controller: Words;
  readonly heading: Words;
  readonly rights: Words;
}

export const privacyText: PrivacyText = {
  approval: "proposed",
  controller: {
    en: "Vektorprogrammet (organisation number 998744814) is the controller of the data on this form.",
    no: "Vektorprogrammet (organisasjonsnummer 998744814) er behandlingsansvarlig for opplysningene i dette skjemaet.",
  },
  heading: { en: "Privacy", no: "Personvern" },
  rights: {
    en: "You can ask to see, correct or delete your data, to receive it in a file, and to withdraw a consent. You can complain to Datatilsynet. Contact us to use your rights.",
    no: "Du kan be om innsyn i, retting av og sletting av opplysningene dine, få dem utlevert i en fil og trekke tilbake samtykker. Du kan klage til Datatilsynet. Kontakt oss for å bruke rettighetene dine.",
  },
};

/** Each consent by name, for the places that say "while the consent is current". */
export const consentNames: Readonly<Record<ConsentKind, Words>> = {
  keepDetails: { en: "keep my details", no: "behold opplysningene mine" },
  news: { en: "alumni news", no: "nyheter for tidligere medlemmer" },
  photo: { en: "photo", no: "bilde" },
};

/** What the generated documents print next to a value that the operator has not decided. */
export const approvalWords: Readonly<Record<Approval, Words | null>> = {
  decided: null,
  proposed: {
    en: "proposed, awaiting operator approval",
    no: "forslag, venter på godkjenning",
  },
};

/** What a privacy notice can await the operator for: its own text, the legal bases that it states, the periods that it states. */
export type NoticeDecision = "bases" | "periods" | "text";

/** The decisions in the order that a draft note names them. */
export const NOTICE_DECISIONS: readonly NoticeDecision[] = [
  "text",
  "bases",
  "periods",
];

/** The words that a draft note names each decision with (spec 0007b R4). */
export const noticeDecisionWords: Readonly<Record<NoticeDecision, Words>> = {
  bases: { en: "the legal bases", no: "de rettslige grunnlagene" },
  periods: { en: "the periods", no: "periodene" },
  text: { en: "the text", no: "teksten" },
};
