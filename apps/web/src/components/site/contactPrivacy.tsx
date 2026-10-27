/**
 * The privacy notice of the contact form (spec 0007b, GDPR Art. 13): what the form collects, why, on which basis, who
 * gets it and how long it is kept. The domain generates it from the declarations of the form's fields and of the columns
 * that hold them, so the notice lists exactly the personal fields of the form and cannot say another period than the
 * retention job applies. Fields that share a purpose, a basis, recipients and a period read as one entry. While the text,
 * a legal basis or a period awaits the operator's approval, the notice says it is a draft.
 */
import type { PrivacyNotice } from "@vektorprogrammet/domain";
import { Array as Arr, Record as Rec } from "effect";

const SEPARATOR = "\u0000";

/** The entries of the notice, with the fields that are kept the same way together. */
const groupsOf = (entries: PrivacyNotice["entries"]) =>
  Rec.values(
    Arr.groupBy(entries, (entry) =>
      Arr.join(
        [entry.purpose.no, entry.basis.no, entry.recipients.no, entry.kept.no],
        SEPARATOR
      )
    )
  );

export const ContactPrivacy = ({
  notice,
}: {
  readonly notice: PrivacyNotice;
}) => (
  <section
    aria-labelledby="personvern-overskrift"
    className="grid gap-2 rounded-md border p-4 text-sm"
    id="personvern"
  >
    <h3 className="font-semibold" id="personvern-overskrift">
      {notice.heading.no}
    </h3>
    {notice.approval === "proposed" && (
      <p className="text-muted-foreground" role="note">
        Utkast: teksten, de rettslige grunnlagene og periodene venter på
        godkjenning.
      </p>
    )}
    <p>{notice.controller.no}</p>
    <ul className="grid gap-1.5">
      {Arr.map(groupsOf(notice.entries), ([first, ...rest]) => (
        <li key={first.field}>
          <span className="font-medium">
            {Arr.join(
              Arr.map([first, ...rest], (entry) => entry.label.no),
              ", "
            )}
          </span>
          {`: ${first.purpose.no}. Grunnlag: ${first.basis.no} (${first.basis.citation}). Mottakere: ${first.recipients.no}. Lagres: ${first.kept.no}.`}
        </li>
      ))}
    </ul>
    <p>{notice.rights.no}</p>
  </section>
);
