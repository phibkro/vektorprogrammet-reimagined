import { blankToNull } from "./formSchema";

const SEMESTER_VALUE = /^(?<term>VAR|HOST)-(?<year>\d{4})$/u;

/** A semester as a form holds it before the domain's schema reads it. */
interface SemesterText {
  readonly term: string;
  readonly year: number;
}

/**
 * A semester in a `<select>`: `HOST-2026` is what the form holds. Text that is no semester (a form that was altered) is a
 * semester with no year, which the domain's schema refuses in its own words.
 */
export const semesterOfChoice = (value: string | undefined): SemesterText => {
  const { term, year } = SEMESTER_VALUE.exec(value ?? "")?.groups ?? {};

  return term !== undefined && year !== undefined
    ? { term, year: Number(year) }
    : { term: "", year: Number.NaN };
};

/** A semester that may be left blank (the team's default term is taken): blank is nothing. */
export const optionalSemesterOfChoice = (
  value: string | undefined
): SemesterText | null => {
  const text = blankToNull(value);

  return text === null ? null : semesterOfChoice(text);
};
