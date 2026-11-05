import { Array as Arr, Record as Rec } from "effect";

/**
 * The editable texts of the public pages: the `texts` entries of the CMS (`apps/cms`), by slug. A page names the
 * slots it shows; the layout, headings and images are the page's own, and everything else an editor writes lives
 * in the CMS.
 *
 * The slugs of a legacy `static_content.html_id` keep that key, so the importer's texts land in the same slots;
 * the rest were added with the pages that mono-web designed (`apps/web/README.md`, "The public site").
 * `apps/web/test/textSlots.test.ts` checks every slot against the default copy of `apps/cms/seed/seed.json`.
 */
export const TEXT_SLOTS = {
  about: [
    "about-header",
    "about-motivate-children",
    "about-motivate-students",
    "about-try-teaching",
    "about-faq",
  ],
  assistants: [
    "assistants-header",
    "assistants-why",
    "assistants-card-role-model",
    "assistants-card-social",
    "assistants-card-cv",
    "assistants-about",
    "assistants-social",
    "assistants-tasks",
    "assistants-how",
    "assistants-requirements",
    "assistants-process",
  ],
  contact: ["contact-header"],
  home: ["home-tagline"],
  news: ["vektor_i_media"],
  parents: ["parent-header", "parent-assistants-info", "parent-course"],
  schools: [
    "schools-header",
    "schools-about",
    "schools-more",
    "schools-tips",
    "schools-apply",
    "schools-missing-city",
  ],
  team: ["team-header"],
} as const;

export type TextPage = keyof typeof TEXT_SLOTS;

/** Every slot of every page, once. */
export const ALL_TEXT_SLOTS: readonly string[] = Arr.flatten(
  Rec.values(TEXT_SLOTS)
);
