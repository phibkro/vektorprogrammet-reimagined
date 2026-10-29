/**
 * Page data of the public site (spec 0005): Effect programs that read the texts, news, sponsors, FAQ and teams
 * from the CMS (`CmsClient`) and the departments and their admission periods from PostgreSQL, and answer plain,
 * serializable view models (no `DateTime`, no brands the browser cannot revive). Server functions run them
 * through `runQuery`; tests run them against in-memory Layers.
 *
 * The business rules stay in the domain and apply to CMS content unchanged: RULE-267 (a draft is never public:
 * the client returns published entries only), RULE-331 (front page news), RULE-326 (ten per page, newest
 * first), RULE-119 (is admission open), and the footer order of sponsors.
 */
import { CmsClient, PortableText } from "@vektorprogrammet/cms-client";
import type {
  Entry,
  ImageValue,
  NewsData,
  TeamData,
} from "@vektorprogrammet/cms-client";
import {
  AdmissionPeriodRepository,
  Catalog,
  ContactForm,
  DepartmentRepository,
  NotFound,
  contactReceiptNotice,
  hasOpenAdmission,
  osloParts,
  paginate,
  privacyNotice,
  selectFrontPageNews,
  slugify,
  sortSponsorsForFooter,
} from "@vektorprogrammet/domain";
import type { Department, PrivacyNotice } from "@vektorprogrammet/domain";
import {
  Array as Arr,
  DateTime,
  Effect,
  Option,
  Order,
  Record as Rec,
  Result,
  Schema,
  String as Str,
} from "effect";

import { TEXT_SLOTS } from "../../lib/textSlots";
import type { TextPage } from "../../lib/textSlots";

/** A block of Portable Text as the CMS stores it. */
export type PortableTextBlock = PortableText.PortableTextBlock;

/** A text slot: its Portable Text, or `null` when the CMS has no published text for it. */
export type TextView = readonly PortableTextBlock[] | null;

/** The texts of one page, by slot. */
export type TextViews = Readonly<Record<string, TextView>>;

export interface ImageView {
  /** An absolute URL on the CMS (`/_emdash/api/media/file/…` answers without a token). */
  readonly src: string;
  readonly alt: string;
}

export interface DepartmentView {
  readonly id: number;
  readonly name: string;
  readonly shortName: string;
  readonly city: string;
  /** The URL segment of `/team/{slug}`, `/kontakt/{slug}` and `?avdeling={slug}`. */
  readonly slug: string;
  readonly email: string;
  readonly address: string | null;
  /** RULE-119: a period of the department contains now. */
  readonly admissionOpen: boolean;
}

export interface NewsCardView {
  readonly slug: string;
  readonly title: string;
  readonly sticky: boolean;
  /** `dd.mm.yyyy`, Oslo calendar. */
  readonly date: string;
  readonly image: ImageView | null;
}

export interface ArticleView extends NewsCardView {
  readonly content: readonly PortableTextBlock[];
  /** The newest other articles. */
  readonly others: readonly NewsCardView[];
}

export interface SponsorView {
  readonly name: string;
  readonly url: string;
  readonly size: "small" | "medium" | "large";
  readonly logo: ImageView | null;
}

export interface FaqView {
  readonly question: string;
  readonly answer: string;
}

export interface TeamView {
  readonly name: string;
  readonly description: string | null;
  readonly email: string | null;
}

/** The URL segment of a department: its city, with Å as `aa` (mono-web's `/kontakt/aas`), as a slug. */
export const departmentSlug = (city: string): string =>
  slugify(Str.replaceAll("å", "aa")(Str.replaceAll("Å", "Aa")(city)));

const osloDate = (instant: DateTime.DateTime): string => {
  const { day, month, year } = osloParts(instant);

  return `${Str.padStart(2, "0")(String(day))}.${Str.padStart(2, "0")(String(month))}.${year}`;
};

/** The date an article is shown and ordered by: when it was published, else when it was created. */
const publishedOn = (entry: Entry<NewsData>): DateTime.Utc =>
  entry.publishedAt ?? entry.createdAt;

const imageOf = (
  cms: { readonly absoluteUrl: (path: string) => string },
  image: ImageValue | null | undefined
): ImageView | null =>
  image === null || image === undefined || image.src === undefined
    ? null
    : { alt: image.alt ?? "", src: cms.absoluteUrl(image.src) };

/**
 * Text an editor wrote refers to its pictures by the CMS's own media path (`/_emdash/api/media/file/…`), which
 * only the CMS origin answers: the page shows them from there.
 */
const withMediaOrigin = (
  cms: { readonly absoluteUrl: (path: string) => string },
  blocks: readonly PortableTextBlock[] | null | undefined
): TextView =>
  blocks === null || blocks === undefined
    ? null
    : Arr.map(blocks, (block) =>
        Schema.is(PortableText.ImageBlock)(block) &&
        block.asset.url !== undefined
          ? {
              ...block,
              asset: { ...block.asset, url: cms.absoluteUrl(block.asset.url) },
            }
          : block
      );

const byCity = (city: string) => (candidate: string) =>
  Str.toLowerCase(candidate) === Str.toLowerCase(city);

const departmentRows = Effect.gen(function* departmentRows() {
  const departments = yield* DepartmentRepository;

  return Arr.sort(
    Arr.filter(yield* departments.list, (department) => department.active),
    Order.mapInput(Order.String, (department: Department) => department.name)
  );
});

/** Active departments by name, each with whether its admission is open now. */
export const departmentViews = Effect.gen(function* departmentViews() {
  const periods = yield* (yield* AdmissionPeriodRepository).list;
  const now = yield* DateTime.now;

  return Arr.map(yield* departmentRows, (department): DepartmentView => ({
    address: department.address,
    admissionOpen: hasOpenAdmission(
      Arr.filter(periods, (period) => period.departmentId === department.id),
      now
    ),
    city: department.city,
    email: department.email,
    id: department.id,
    name: department.name,
    shortName: department.shortName,
    slug: departmentSlug(department.city),
  }));
});

/** The texts of a page's slots. A slot with no published text is `null`. */
export const pageTexts = Effect.fn("pageTexts")(function* pageTexts(
  page: TextPage
) {
  const cms = yield* CmsClient;
  const entries = yield* cms.texts.published;

  const bySlug = Rec.fromEntries(
    Arr.filterMap(entries, (entry) =>
      entry.slug === null
        ? Result.failVoid
        : Result.succeed([
            entry.slug,
            withMediaOrigin(cms, entry.data.content),
          ] as const)
    )
  );

  return Rec.fromEntries(
    Arr.map(TEXT_SLOTS[page], (slot): readonly [string, TextView] => [
      slot,
      bySlug[slot] ?? null,
    ])
  ) satisfies TextViews;
});

const newestFirst = Order.mapInput(Order.flip(DateTime.Order), publishedOn);

const newsCard = (
  cms: { readonly absoluteUrl: (path: string) => string },
  entry: Entry<NewsData>
): NewsCardView => ({
  date: osloDate(publishedOn(entry)),
  image: imageOf(cms, entry.data.image),
  slug: entry.slug ?? "",
  sticky: entry.data.sticky ?? false,
  title: entry.data.title,
});

/** An article the public can read: published, with a slug to link to. */
const readableArticles = Effect.gen(function* readableArticles() {
  const cms = yield* CmsClient;

  return {
    cms,
    entries: Arr.sort(
      Arr.filter(yield* cms.news.published, (entry) => entry.slug !== null),
      newestFirst
    ),
  };
});

/** Sponsors for the footer: large first, then by name. */
export const footerSponsors = Effect.gen(function* footerSponsors() {
  const cms = yield* CmsClient;

  return Arr.map(
    sortSponsorsForFooter(
      Arr.map(yield* cms.sponsors.published, (entry) => entry.data)
    ),
    (sponsor): SponsorView => ({
      logo: imageOf(cms, sponsor.logo),
      name: sponsor.name,
      size: sponsor.size,
      url: sponsor.url,
    })
  );
});

/** Hjem: the tagline, the departments with their admission, and the front page news (RULE-331). */
export const homePage = Effect.gen(function* homePage() {
  const { cms, entries } = yield* readableArticles;
  const now = yield* DateTime.now;

  const front = selectFrontPageNews(
    Arr.map(entries, (entry) => ({
      card: newsCard(cms, entry),
      createdAt: publishedOn(entry),
      published: true,
      sticky: entry.data.sticky ?? false,
    })),
    now,
    3
  );

  return {
    departments: yield* departmentViews,
    news: Arr.map(front, ({ card }) => card),
    texts: yield* pageTexts("home"),
  };
});

export const aboutPage = Effect.all({ texts: pageTexts("about") });

export const parentsPage = Effect.all({ texts: pageTexts("parents") });

export const schoolsPage = Effect.all({
  departments: departmentViews,
  texts: pageTexts("schools"),
});

const byPosition = Order.mapInput(
  Order.Number,
  (entry: Entry<{ readonly position: number }>) => entry.data.position
);

const faqFor = Effect.fn("faqFor")(function* faqFor(
  page: "assistenter" | "team"
) {
  const { faq } = yield* CmsClient;

  return Arr.map(
    Arr.sort(
      Arr.filter(yield* faq.published, (entry) => entry.data.page === page),
      byPosition
    ),
    (entry): FaqView => ({
      answer: entry.data.answer,
      question: entry.data.question,
    })
  );
});

/** Assistenter: the texts, the questions, and the departments (with whether admission is open). */
export const assistantsPage = Effect.all({
  departments: departmentViews,
  faq: faqFor("assistenter"),
  texts: pageTexts("assistants"),
});

export interface TeamPageView {
  readonly departments: readonly DepartmentView[];
  /** `null` when there is no active department at all. */
  readonly selected: DepartmentView | null;
  readonly teams: readonly TeamView[];
  readonly faq: readonly FaqView[];
  readonly texts: TextViews;
}

/**
 * Team: the departments, the teams of the selected one (the first when no slug is given), the texts and the
 * questions. An unknown slug is `NotFound`. Team applications are Phase 3.
 */
export const teamPage = Effect.fn("teamPage")(function* teamPage(
  slug: string | null
) {
  const departments = yield* departmentViews;
  const { teams } = yield* CmsClient;

  const selected =
    slug === null
      ? Arr.head(departments)
      : Arr.findFirst(departments, (department) => department.slug === slug);

  if (slug !== null && Option.isNone(selected)) {
    return yield* new NotFound({ entity: "Department", key: slug });
  }

  const ofSelected = (entry: Entry<TeamData>): boolean =>
    Option.exists(selected, (department) =>
      byCity(department.city)(entry.data.department)
    );

  return {
    departments,
    faq: yield* faqFor("team"),
    selected: Option.getOrNull(selected),
    teams: Arr.map(
      Arr.sort(Arr.filter(yield* teams.published, ofSelected), byPosition),
      (entry): TeamView => ({
        description: entry.data.description ?? null,
        email: entry.data.email ?? null,
        name: entry.data.name,
      })
    ),
    texts: yield* pageTexts("team"),
  } satisfies TeamPageView;
});

export interface NewsPageView {
  readonly items: readonly NewsCardView[];
  readonly page: number;
  readonly totalPages: number;
  readonly totalItems: number;
  readonly departments: readonly DepartmentView[];
  /** The department the list is filtered to, when `avdeling` named one. */
  readonly department: DepartmentView | null;
  /** `avdeling` named a department that does not exist: the list is every article. */
  readonly unknownDepartment: boolean;
  readonly texts: TextViews;
}

/**
 * Nyheter: RULE-326 (ten per page, newest first). `avdeling` is a department's slug or short name; an article
 * is for a department when it is tagged with its city or with none (every department).
 */
export const newsPage = Effect.fn("newsPage")(function* newsPage(query: {
  readonly page: number;
  readonly department: string | null;
}) {
  const { cms, entries } = yield* readableArticles;
  const departments = yield* departmentViews;

  const wanted = Option.fromNullishOr(query.department).pipe(
    Option.map(Str.toLowerCase)
  );

  const department = wanted.pipe(
    Option.flatMap((name) =>
      Arr.findFirst(
        departments,
        (candidate) =>
          candidate.slug === name ||
          Str.toLowerCase(candidate.shortName) === name
      )
    )
  );

  const visible = Option.match(department, {
    onNone: () => entries,
    onSome: (selected) =>
      Arr.filter(
        entries,
        (entry) =>
          (entry.data.departments ?? []).length === 0 ||
          Arr.some(entry.data.departments ?? [], byCity(selected.city))
      ),
  });

  const shown = paginate(
    Arr.map(visible, (entry) => newsCard(cms, entry)),
    query.page
  );

  return {
    department: Option.getOrNull(department),
    departments,
    items: shown.items,
    page: shown.page,
    texts: yield* pageTexts("news"),
    totalItems: shown.totalItems,
    totalPages: Math.max(1, shown.totalPages),
    unknownDepartment: query.department !== null && Option.isNone(department),
  } satisfies NewsPageView;
});

/** Nyhet: RULE-267, a draft or an unknown slug is `NotFound`. */
export const articlePage = Effect.fn("articlePage")(function* articlePage(
  slug: string
) {
  const { cms, entries } = yield* readableArticles;

  const found = Arr.findFirst(entries, (entry) => entry.slug === slug);

  if (Option.isNone(found)) {
    return yield* new NotFound({ entity: "Article", key: slug });
  }

  return {
    ...newsCard(cms, found.value),
    content: withMediaOrigin(cms, found.value.data.content) ?? [],
    others: Arr.map(
      Arr.take(
        Arr.filter(entries, (entry) => entry.slug !== slug),
        5
      ),
      (entry) => newsCard(cms, entry)
    ),
  } satisfies ArticleView;
});

export interface ContactPageView {
  readonly departments: readonly DepartmentView[];
  /** The department of the selected tab (the first when the URL names none). */
  readonly selected: DepartmentView;
  readonly texts: TextViews;
  /** The receipt notice after a successful post (legacy wording, from the domain). */
  readonly notice: string | null;
  /** What the form collects, why, and how long it is kept: generated from the declarations (spec 0007b). */
  readonly privacy: PrivacyNotice;
}

/** Kontakt: `slug` selects the tab; `sentTo` is the department of a just-sent message. */
export const contactPage = Effect.fn("contactPage")(function* contactPage(
  slug: string | null,
  sentTo: boolean
) {
  const departments = yield* departmentViews;

  const selected =
    slug === null
      ? Arr.head(departments)
      : Arr.findFirst(departments, (department) => department.slug === slug);

  if (Option.isNone(selected)) {
    return yield* new NotFound({ entity: "Department", key: slug ?? "" });
  }

  return {
    departments,
    notice: sentTo ? contactReceiptNotice(selected.value) : null,
    privacy: privacyNotice(ContactForm, Catalog),
    selected: selected.value,
    texts: yield* pageTexts("contact"),
  } satisfies ContactPageView;
});

/** The URL segment of an active department by its legacy id (the old `/kontakt/avdeling/{id}` address); unknown or inactive is `NotFound`. */
export const departmentSlugById = Effect.fn("departmentSlugById")(
  function* departmentSlugById(id: number | null) {
    const found = Arr.findFirst(
      yield* departmentRows,
      (department) => department.id === id
    );

    if (Option.isNone(found)) {
      return yield* new NotFound({ entity: "Department", key: String(id) });
    }

    return departmentSlug(found.value.city);
  }
);
