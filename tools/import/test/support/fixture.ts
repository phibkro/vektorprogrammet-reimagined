/**
 * FAKE legacy data for the round trip. Every name, address, e-mail, URL and
 * file is invented (`.example` domains); nothing comes from the backup.
 *
 * The rows exercise each mapping rule; the expected outcome is noted per row.
 */

/** Legacy upload paths of the fake files and their bytes (typed by magic bytes, RULE-130). */
const jpeg = (tag: string) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(tag)]);
const png = (tag: string) =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...new TextEncoder().encode(tag),
  ]);

export const FAKE_FILES: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }> = [
  { path: "images/article_images/bilde-1.jpg", bytes: jpeg("bilde-1") },
  { path: "images/article_images/stor-1.jpg", bytes: jpeg("stor-1") },
  { path: "images/article_images/liten-1.jpg", bytes: jpeg("liten-1") },
  { path: "images/article_images/stor-felles.jpg", bytes: jpeg("stor-felles") },
  { path: "images/article_images/liten-felles.jpg", bytes: jpeg("liten-felles") },
  { path: "images/Logo images/alfa-logo.png", bytes: png("logo") },
  // Same bytes as alfa-logo.png: one public_file row, one path "sharing content".
  { path: "images/Logo images/sponsor-en.png", bytes: png("logo") },
  {
    path: "Offentlige filer/Dokumenter/info.pdf",
    bytes: new TextEncoder().encode("%PDF-1.4 fake"),
  },
];

/** Strings that must never reach the report (names, e-mails, titles, file names, free text). */
export const PERSONAL_SENTINELS = [
  "Avdeling Alfa",
  "kontakt@alfa.example",
  "ikke-en-adresse",
  "Alfaby",
  "Fag Alfa",
  "Opptak åpner",
  "bilde-1.jpg",
  "info.pdf",
  "alfa-logo",
  "Om oss",
  "Sponsor En",
  "Sosialt treff",
];

/** Rich text of article 1: an image, a public file, a script, an unmapped asset and a missing image. */
export const ARTICLE_1_BODY =
  '<p>Hei</p><img src="/images/article_images/bilde-1.jpg"><script>alert(1)</script>' +
  '<a href="/Offentlige%20filer/Dokumenter/info.pdf">info</a>' +
  '<img src="/images/team_images/x.png"><img src="/images/article_images/finnes-ikke.jpg">';

/** Static block 1: an event handler and an absolute URL on the legacy host. */
export const STATIC_1_HTML =
  '<p onclick="steal()">Om oss</p><img src="https://vektorprogrammet.no/images/article_images/bilde-1.jpg">';

const quote = (value: string | number | null): string =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

const insert = (
  table: string,
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string | number | null>>,
): string =>
  `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(", ")}) VALUES\n` +
  rows.map((row) => `  (${row.map(quote).join(", ")})`).join(",\n") +
  ";";

export const FIXTURE_SQL = [
  insert(
    "department",
    [
      "id",
      "name",
      "short_name",
      "email",
      "address",
      "city",
      "slackChannel",
      "logo_path",
      "latitude",
      "longitude",
      "active",
    ],
    [
      // 1: valid; percent-encoded logo path.
      [
        1,
        "Avdeling Alfa",
        "ALFA",
        "kontakt@alfa.example",
        "Alfaveien 1",
        "Alfaby",
        "#alfa",
        "/images/Logo%20images/alfa-logo.png",
        "63.4",
        "10.4",
        1,
      ],
      // 2: valid; blank address → NULL (normalisation).
      [2, "Avdeling Beta", "BETA", "kontakt@beta.example", "", "Betaby", null, null, null, null, 1],
      // 3: invalid e-mail → quarantined.
      [3, "Avdeling Gamma", "GAMMA", "ikke-en-adresse", null, "Gammaby", null, null, null, null, 0],
    ],
  ),
  insert(
    "semester",
    ["id", "semesterTime", "year"],
    [
      [1, "Vår", "2024"],
      [2, "Høst", "2024"],
      [3, "Vår", "2024"], // duplicate of 1 → collapsed
      [4, "Høst", "2024"], // duplicate of 2 → collapsed
      [5, "Høst", "2024"], // duplicate of 2 → collapsed
      [6, "Sommer", "2024"], // invalid term → quarantined
      [7, "Vår", "20x5"], // invalid year → quarantined
    ],
  ),
  insert(
    "field_of_study",
    ["id", "department_id", "name", "short_name"],
    [
      [1, 1, "Fag Alfa", "FA"],
      [2, 2, "Fag Beta", "FB"],
      [3, null, "Fag Foreldreløs", "FF"], // orphan (NULL department) → quarantined
      [4, 99, "Fag Borte", "FX"], // absent department → quarantined
      [5, 3, "Fag Gamma", "FG"], // quarantined department → quarantined
    ],
  ),
  insert(
    "AdmissionPeriod",
    ["id", "department_id", "semester_id", "start_date", "end_date", "infoMeeting_id"],
    [
      [1, 1, 3, "2024-01-10 08:00:00", "2024-02-01 23:59:59", null], // semester 3 → 1
      [2, 2, 2, "2024-08-10 00:00:00", "2024-08-01 00:00:00", null], // end before start → quarantined
    ],
  ),
  insert(
    "article",
    [
      "id",
      "author_id",
      "title",
      "article",
      "imageLarge",
      "imageSmall",
      "created",
      "updated",
      "sticky",
      "published",
      "slug",
    ],
    [
      [
        1,
        42,
        "Opptak åpner",
        ARTICLE_1_BODY,
        "/images/article_images/stor-1.jpg",
        "/images/article_images/liten-1.jpg",
        "2024-01-15 12:00:00",
        "2024-01-16 12:00:00",
        1,
        1,
        "opptak-apner",
      ],
      // 2: a draft (RULE-267).
      [
        2,
        null,
        "Kladd",
        "<p>Utkast</p>",
        "/images/article_images/stor-felles.jpg",
        "/images/article_images/liten-felles.jpg",
        "2024-02-01 09:30:00",
        "2024-02-01 09:30:00",
        0,
        0,
        "kladd",
      ],
      // 3: published NULL → false (normalisation).
      [
        3,
        null,
        "Uten status",
        "<p>Tekst</p>",
        "/images/article_images/stor-felles.jpg",
        "/images/article_images/liten-felles.jpg",
        "2024-03-01 10:00:00",
        "2024-03-01 10:00:00",
        0,
        null,
        "uten-status",
      ],
    ],
  ),
  insert(
    "articles_departments",
    ["article_id", "department_id"],
    [
      [1, 1],
      [1, 99], // absent department
      [2, 2],
      [4, 1], // absent article
    ],
  ),
  insert(
    "static_content",
    ["id", "html_id", "html"],
    [
      [1, "about-intro", STATIC_1_HTML],
      [2, "about-intro", "<p>Andre versjon</p>"], // duplicate key → quarantined
      [3, "foreldre", "<p>Foreldre</p>"],
    ],
  ),
  insert(
    "sponsor",
    ["id", "name", "url", "logoImagePath", "size"],
    [
      [
        1,
        "Sponsor En",
        "https://sponsor-en.example",
        "/images/Logo images/sponsor-en.png",
        "large",
      ],
      [2, "Sponsor To", "www.uten-skjema.example", null, "small"], // not an absolute URL → quarantined
      [3, "Sponsor Tre", "https://sponsor-tre.example", null, "gigantic"], // unknown size → quarantined
    ],
  ),
  insert(
    "event",
    [
      "id",
      "department_id",
      "semester_id",
      "role_id",
      "title",
      "description",
      "startTime",
      "endTime",
      "link",
    ],
    [
      // 1: role_id is dropped (RULE-188); semester 4 → 2.
      [
        1,
        1,
        4,
        7,
        "Sosialt treff",
        "Pizza",
        "2024-09-05 18:00:00",
        "2024-09-05 21:00:00",
        "https://treff.example",
      ],
      [2, 1, 2, null, "", "Uten tittel", "2024-09-06 18:00:00", "2024-09-06 21:00:00", null], // blank title
      [3, 2, 2, null, "Baklengs", "", "2024-09-07 21:00:00", "2024-09-07 18:00:00", ""], // end before start
      [4, 2, 6, null, "Sommerfest", "", "2024-06-07 18:00:00", "2024-06-07 21:00:00", null], // quarantined semester
    ],
  ),
].join("\n\n");

/** The Phase 1 legacy tables whose definitions are loaded from `prod-schema.sql`. */
export const PHASE_1_LEGACY_TABLES = [
  "AdmissionPeriod",
  "article",
  "articles_departments",
  "department",
  "event",
  "field_of_study",
  "semester",
  "sponsor",
  "static_content",
] as const;
