/**
 * The two alumni questions (spec 0007b), as Min side and the page of the alumni e-mail show them: the text of each
 * consent as the domain declares it, and a Ja and a Nei button. One click answers one question and leaves the other as
 * it was. The text, and the version a record names, are `consentTexts`; the page makes none up.
 */
import { consentTexts } from "@vektorprogrammet/domain";
import type { ConsentSummary } from "@vektorprogrammet/domain";
import { Array as Arr } from "effect";

import { CommandForm } from "@/components/forms";
import type { Outcome } from "@/lib/outcome";

const QUESTIONS = [
  { kind: "keepDetails", title: "Behold opplysningene mine" },
  { kind: "news", title: "Nyheter for tidligere medlemmer" },
] as const;

const ANSWERS = [
  { label: "Ja", value: "yes" },
  { label: "Nei", value: "no" },
] as const;

const STATUS = { no: "Nei", yes: "Ja" } as const;

export const ConsentQuestions = ({
  action,
  answers,
  credential,
}: {
  readonly action: (options: { data: FormData }) => Promise<Outcome<string>>;
  /** What the person has answered so far, when the page knows it (Min side); `null` on the page of the e-mail. */
  readonly answers: ConsentSummary | null;
  /** The hidden field that says who answers: `personId` on Min side, `code` on the page of the e-mail. */
  readonly credential: {
    readonly name: "code" | "personId";
    readonly value: string;
  };
}) => (
  <div className="grid gap-6">
    {Arr.map(QUESTIONS, ({ kind, title }) => {
      const current = answers?.[kind] ?? null;

      return (
        <fieldset className="grid gap-3" key={kind}>
          <legend className="font-medium">{title}</legend>
          <p>{consentTexts[kind].no}</p>
          {consentTexts[kind].approval === "proposed" && (
            <p className="text-muted-foreground text-sm">
              Utkast: teksten venter på godkjenning.
            </p>
          )}
          {answers !== null && (
            <p>{`Svaret ditt nå: ${current === null ? "ikke besvart" : STATUS[current]}`}</p>
          )}
          <div className="flex flex-wrap gap-3">
            {Arr.map(ANSWERS, ({ label, value }) => (
              <CommandForm
                action={action}
                className="flex items-center gap-3"
                key={value}
                submitLabel={label}
              >
                <input
                  name={credential.name}
                  type="hidden"
                  value={credential.value}
                />
                <input name="kind" type="hidden" value={kind} />
                <input name="answer" type="hidden" value={value} />
              </CommandForm>
            ))}
          </div>
        </fieldset>
      );
    })}
  </div>
);
