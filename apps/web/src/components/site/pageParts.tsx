/**
 * Parts the public pages share, ported from mono-web's homepage (`apps/homepage/src`, commit 2aa6ce97):
 * `Divider`, `TextPictureParagraph`, the FAQ accordion, and the admission status that the organisation data
 * (PostgreSQL) answers. The text of a part is a CMS slot (`PortableTextView`); the image is the design's.
 */
import { Link } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { PortableTextView } from "@/components/site/portableTextView";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { cn } from "@/lib/utils";
import type { DepartmentView, FaqView, TextView } from "@/server/site/pages";

/** The logo and a rule between sections on narrow screens. */
export const Divider = () => (
  <div className="mt-5 mb-5 flex h-24 w-full flex-col items-center opacity-30 md:hidden">
    <img
      alt="Vektorprogrammet logo"
      className="relative top-6 w-10 bg-white"
      src="/images/vektor-logo-circle.svg"
    />
    <div className="bg-vektor-blue h-1 w-10/12 rounded-full" />
  </div>
);

/** A text beside a picture; the picture swaps sides when `pictureOnLeft`. */
export const TextPictureParagraph = ({
  alt,
  pictureOnLeft,
  src,
  text,
}: {
  readonly text: TextView;
  readonly src: string;
  readonly alt: string;
  readonly pictureOnLeft: boolean;
}) => (
  <div
    className={cn(
      "flex flex-wrap items-center justify-center gap-5 md:flex-nowrap md:justify-between md:gap-14",
      pictureOnLeft && "md:flex-row-reverse"
    )}
  >
    <img
      alt={alt}
      className="flex max-h-96 rounded-lg sm:w-auto md:h-fit md:max-w-96"
      src={src}
    />
    <PortableTextView className="flex max-w-6xl flex-col" value={text} />
    <Divider />
  </div>
);

/** "Ofte stilte spørsmål": the questions an editor keeps in the CMS, one open at a time. */
export const FaqSection = ({ faq }: { readonly faq: readonly FaqView[] }) =>
  faq.length === 0 ? null : (
    <div className="flex w-4/5 max-w-4xl flex-col items-center gap-10 self-center">
      <h2 className="text-vektor-DARKblue w-full text-center text-2xl font-bold md:text-4xl">
        Ofte stilte spørsmål
      </h2>
      <Accordion className="w-full">
        {Arr.map(faq, ({ answer, question }) => (
          <AccordionItem key={question} value={question}>
            <AccordionTrigger>
              <span className="text-left text-base">{question}</span>
            </AccordionTrigger>
            <AccordionContent>
              <p className="text-left text-base whitespace-pre-line">
                {answer}
              </p>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );

/** mono-web's green button (`Button variant="green"`) as a class for links. */
export const greenButtonClass =
  "inline-flex items-center justify-center rounded-md bg-vektor-green px-4 py-2 font-medium text-white no-underline transition-colors hover:bg-vektor-green-hover";

/**
 * Which departments have admission open now (RULE-119, from the organisation data), each with the way to its
 * contact page. Applications themselves are Phase 3; today a department is asked.
 */
export const AdmissionStatus = ({
  className,
  departments,
  tone = "light",
}: {
  readonly departments: readonly DepartmentView[];
  readonly className?: string;
  readonly tone?: "light" | "dark";
}) => {
  const open = Arr.filter(
    departments,
    (department) => department.admissionOpen
  );

  return (
    <section
      aria-labelledby="admission-heading"
      className={cn("flex flex-col items-center gap-4 text-center", className)}
      data-testid="admission-status"
    >
      <h2
        className={cn(
          "font-bold md:text-xl",
          tone === "dark" ? "text-vektor-bg" : "text-vektor-DARKblue"
        )}
        id="admission-heading"
      >
        {open.length > 0
          ? `Opptaket er åpent i ${Arr.join(
              Arr.map(open, (department) => department.city),
              ", "
            )}.`
          : "Opptaket er stengt for øyeblikket."}
      </h2>
      {open.length > 0 && (
        <nav
          aria-label="Åpent opptak"
          className="flex flex-wrap justify-center gap-3"
        >
          {Arr.map(open, (department) => (
            <Link
              className={cn(greenButtonClass, "min-w-40")}
              key={department.id}
              params={{ department: department.slug }}
              to="/kontakt/$department"
            >
              {`Kontakt ${department.shortName}`}
            </Link>
          ))}
        </nav>
      )}
    </section>
  );
};

/** The pill-shaped department links of the team and contact pages. */
export const departmentLinkClass = (current: boolean) =>
  cn(
    "focus-visible:ring-ring inline-flex min-h-10 max-w-full items-center justify-center rounded-full px-4 py-2 text-center text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
    current
      ? "bg-vektor-darkblue text-white"
      : "hover:bg-vektor-light-blue text-black"
  );
