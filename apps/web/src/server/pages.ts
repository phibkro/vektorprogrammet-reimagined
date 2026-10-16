/**
 * Public page data (C3–C6, C10): Effect programs over the domain's queries,
 * returning plain, serializable view models (no `DateTime`, no brands the
 * browser cannot revive). Server functions run these through `runQuery`;
 * tests run them against in-memory Layers.
 */
import {
  DepartmentRepository,
  NotFound,
  StaticContentKey,
  getPublicArticle,
  contactReceiptNotice,
  getStaticContent,
  listSponsorsForFooter,
  loadFrontPageNews,
  loadNewsPage,
  osloParts,
} from "@vektorprogrammet/domain";
import type { Article, Department } from "@vektorprogrammet/domain";
import type { DateTime } from "effect";
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect";

/** Legacy `html_id`s of the editable blocks each public page embeds (from the legacy templates). */
export const STATIC_BLOCKS = {
  foreldre: ["parent-header", "parent-assistants-info", "parent-course"],
  home: ["home-tagline"],
  kontakt: ["contact-header"],
  nyheter: ["vektor_i_media"],
  omvektor: [
    "about-header",
    "about-motivate-children",
    "about-motivate-students",
    "about-try-teaching",
    "about-faq",
  ],
} as const;

export type StaticPage = keyof typeof STATIC_BLOCKS;

/** Sanitized HTML by block key; `null` when the block has not been written yet. */
export type StaticBlocks = Readonly<Record<string, string | null>>;

export interface DepartmentSummary {
  readonly id: number;
  readonly name: string;
  readonly shortName: string;
  readonly city: string;
  readonly email: string;
}

export interface ArticleSummary {
  readonly slug: string;
  readonly title: string;
  readonly sticky: boolean;
  readonly imageSmallKey: string;
  /** `dd.mm.yyyy`, Oslo calendar. */
  readonly date: string;
}

export interface ArticleView extends ArticleSummary {
  readonly imageLargeKey: string;
  /** Sanitized on save and again on read (RULE-133 replacement). */
  readonly bodyHtml: string;
}

const osloDate = (instant: DateTime.DateTime): string => {
  const { day, month, year } = osloParts(instant);

  return `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`;
};

const summary = (article: Article): ArticleSummary => ({
  date: osloDate(article.createdAt),
  imageSmallKey: article.imageSmallKey,
  slug: article.slug,
  sticky: article.sticky,
  title: article.title,
});

export const staticBlocks = (page: StaticPage) =>
  Effect.forEach(STATIC_BLOCKS[page], (key) =>
    Effect.map(
      getStaticContent(StaticContentKey.make(key)),
      (block) =>
        [
          key,
          Option.match(block, {
            onNone: () => null,
            onSome: (found): string | null => found.html,
          }),
        ] as const
    )
  ).pipe(Effect.map((entries): StaticBlocks => Rec.fromEntries(entries)));

const departmentSummary = (department: Department): DepartmentSummary => ({
  city: department.city,
  email: department.email,
  id: department.id,
  name: department.name,
  shortName: department.shortName,
});

const activeDepartmentRows = Effect.gen(function* activeDepartmentRows() {
  const departments = yield* DepartmentRepository;

  return Arr.sort(
    Arr.filter(yield* departments.list, (department) => department.active),
    Order.mapInput(Order.String, (department: Department) => department.name)
  );
});

/** Active departments, by name; the visitor picks one (RULE-327 replacement). */
export const activeDepartments = Effect.map(
  activeDepartmentRows,
  Arr.map(departmentSummary)
);

export interface ContactPageView {
  readonly departments: readonly DepartmentSummary[];
  readonly blocks: StaticBlocks;
  /** The receipt notice after a successful post (legacy wording, from the domain). */
  readonly notice: string | null;
}

/** C10 `/kontakt` and `/kontakt/avdeling/{id}`; `sentTo` is the department of a just-sent ticket. */
export const contactPage = Effect.fn("contactPage")(function* contactPage(
  sentTo: number | null
) {
  const departments = yield* activeDepartmentRows;

  const receiver = Option.getOrUndefined(
    Arr.findFirst(departments, (department) => department.id === sentTo)
  );

  return {
    blocks: yield* staticBlocks("kontakt"),
    departments: Arr.map(departments, departmentSummary),
    notice: receiver === undefined ? null : contactReceiptNotice(receiver),
  } satisfies ContactPageView;
});

/** C3 home: departments, recent or sticky news (RULE-331), the tagline block. */
export const homePage = Effect.all({
  blocks: staticBlocks("home"),
  departments: activeDepartments,
  news: Effect.map(loadFrontPageNews(), Arr.map(summary)),
});

export interface NewsPageView {
  readonly items: readonly ArticleSummary[];
  readonly page: number;
  readonly totalPages: number;
  readonly totalItems: number;
  /** Set on `/nyheter/{department}`. */
  readonly department: DepartmentSummary | null;
  readonly departments: readonly DepartmentSummary[];
  readonly blocks: StaticBlocks;
}

/**
 * C5 `/nyheter` and `/nyheter/{department}` (RULE-326: 10 per page, newest
 * first). `department` is a short name (legacy URL); unknown → `NotFound`.
 */
export const newsPage = Effect.fn("newsPage")(function* newsPage(query: {
  readonly page: number;
  readonly department: string | null;
}) {
  const departments = yield* activeDepartmentRows;
  const wanted = query.department?.toLowerCase();

  const department =
    wanted === undefined
      ? undefined
      : Option.getOrUndefined(
          Arr.findFirst(
            departments,
            (candidate) => candidate.shortName.toLowerCase() === wanted
          )
        );

  if (query.department !== null && department === undefined) {
    return yield* new NotFound({ entity: "Department", key: query.department });
  }

  const page = yield* loadNewsPage(
    department === undefined
      ? { page: query.page }
      : { departmentId: department.id, page: query.page }
  );

  return {
    blocks: yield* staticBlocks("nyheter"),
    department: department === undefined ? null : departmentSummary(department),
    departments: Arr.map(departments, departmentSummary),
    items: Arr.map(page.items, summary),
    page: page.page,
    totalItems: page.totalItems,
    totalPages: page.totalPages,
  } satisfies NewsPageView;
});

/** C5 `/nyhet/{slug}`: drafts and unknown slugs are `NotFound` (RULE-267). */
export const articlePage = Effect.fn("articlePage")(function* articlePage(
  slug: string
) {
  const article = yield* getPublicArticle(slug);

  return {
    ...summary(article),
    bodyHtml: article.body,
    imageLargeKey: article.imageLargeKey,
  } satisfies ArticleView;
});

export interface SponsorView {
  readonly name: string;
  readonly url: string;
  readonly size: "small" | "medium" | "large";
  readonly logoKey: string | null;
}

/** C6 footer sponsors, large first. */
export const footerSponsors = Effect.map(listSponsorsForFooter, (sponsors) =>
  Arr.map(sponsors, (sponsor): SponsorView => ({
    logoKey: sponsor.logoKey,
    name: sponsor.name,
    size: sponsor.size,
    url: sponsor.url,
  }))
);
