/**
 * The control panel's sections, in the order the sidebar lists them: labels and paths only, so the
 * browser may import it. Who may use a section is not here. The server decides, from the domain's
 * capabilities (`server/shell.ts`), and sends the sidebar only the sections the actor may use.
 */
import { Array as Arr, Option } from "effect";

export const PANEL_SECTIONS = [
  {
    group: "Generelt",
    key: "overview",
    label: "Oversikt",
    to: "/kontrollpanel",
  },
  {
    group: "Organisasjon",
    key: "departments",
    label: "Avdelinger",
    to: "/kontrollpanel/avdelinger",
  },
  {
    group: "Organisasjon",
    key: "semesters",
    label: "Semestre",
    to: "/kontrollpanel/semestre",
  },
  {
    group: "Organisasjon",
    key: "fieldsOfStudy",
    label: "Linjer",
    to: "/kontrollpanel/linjer",
  },
  {
    group: "Innhold",
    key: "staticContent",
    label: "Statisk innhold",
    to: "/kontrollpanel/statisk-innhold",
  },
  {
    group: "Innhold",
    key: "articles",
    label: "Artikler",
    to: "/kontrollpanel/artikler",
  },
  {
    group: "Innhold",
    key: "sponsors",
    label: "Sponsorer",
    to: "/kontrollpanel/sponsorer",
  },
  {
    group: "Innhold",
    key: "socialEvents",
    label: "Arrangementer",
    to: "/kontrollpanel/arrangementer",
  },
] as const;

export type PanelSection = (typeof PANEL_SECTIONS)[number];

export type SectionKey = PanelSection["key"];

/** What the server sends for one sidebar entry. */
type NavigationItem = Pick<PanelSection, "key" | "label" | "to">;

/** A labelled run of entries. */
export interface NavigationGroup {
  readonly label: string;
  readonly items: readonly NavigationItem[];
}

/** The section a pathname belongs to; undefined for a path that is no section (a not-found page). */
export const sectionOfPath = (pathname: string): PanelSection | undefined =>
  Option.getOrUndefined(
    Arr.findFirst(
      PANEL_SECTIONS,
      (section) => section.to === pathname.replace(/\/$/u, "")
    )
  );
