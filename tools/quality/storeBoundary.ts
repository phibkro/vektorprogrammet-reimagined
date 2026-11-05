/**
 * Where the store adapter and the database engine packages may be imported (spec 0017, ADR 0014 stage 1).
 *
 * The PostgreSQL adapter lives in `apps/web/src/adapters/db`. Code outside it asks for a domain port;
 * a composition root provides the adapter Layer. This module declares the rule:
 *
 * - `restricted` says which module specifiers are restricted, in groups;
 * - `allowances` says which files may import which group, and why;
 * - the root `vite.config.ts` builds Oxlint's `no-restricted-imports` options from both (`restrictedImportPatterns`,
 *   `boundaryOverrides`), so the lint and `checkStoreBoundary.ts` cannot disagree about a specifier;
 * - `checkStoreBoundary.ts` fails on a file that imports a restricted module without an allowance, and on an allowance
 *   that no file needs, so the list can only shrink.
 *
 * A file must be covered by at most one allowance: a later Oxlint override replaces the rule's options instead of adding
 * to them, so two covering entries would make the lint stricter than the declaration says.
 */
import { Array as Arr, Record as Rec } from "effect";
import type { Option } from "effect";

export type Group = "db" | "removed-db" | "drizzle" | "pg" | "sql-pg";

interface Restriction {
  readonly message: string;
  /** Regular expressions over a module specifier (the Rust and the JavaScript syntax agree on these). */
  readonly regexes: readonly string[];
}

const restricted: Readonly<Record<Group, Restriction>> = {
  db: {
    message:
      "The PostgreSQL adapter is internal: code outside it asks for a domain port, and a composition root provides the adapter's Layer (spec 0017).",
    regexes: [
      "(?:^|/)apps/web/src/adapters/db(?:/|$)",
      "(?:^|/)adapters/db(?:/|$)",
      "(?:^|/)apps/web/test/db(?:/|$)",
    ],
  },
  drizzle: {
    message:
      "Drizzle is an adapter detail of `apps/web/src/adapters/db`: go through a domain port (spec 0017).",
    regexes: ["^drizzle-orm(?:/|$)"],
  },
  pg: {
    message:
      "`pg` is an engine adapter detail: use the domain ports outside database adapters and their tests.",
    regexes: ["^pg(?:/|$)"],
  },
  "removed-db": {
    message:
      "The @vektorprogrammet/db package was removed; import the appropriate consolidated adapter file only at an allowed boundary.",
    regexes: ["^@vektorprogrammet/db(?:/|$)"],
  },
  "sql-pg": {
    message:
      "`@effect/sql-pg` is the PostgreSQL client of `apps/web/src/adapters/db`: go through a domain port (spec 0017).",
    regexes: ["^@effect/sql-pg(?:lite)?(?:/|$)"],
  },
};

const allGroups: readonly Group[] = Rec.keys(restricted);

const groups: readonly Group[] = Arr.filter(
  allGroups,
  (group) => group !== "removed-db"
);

export interface Allowance {
  /** Paths from the repository root; `*` stops at a slash and `**` crosses slashes. */
  readonly files: readonly string[];
  readonly allows: readonly Group[];
  readonly reason: string;
}

const adapterTest = ["db", "pg", "sql-pg"] as const satisfies readonly Group[];

export const allowances: readonly Allowance[] = [
  {
    allows: groups,
    files: ["apps/web/src/adapters/db/**", "apps/web/test/db/**"],
    reason: "The adapter and its tests.",
  },
  {
    allows: ["db"],
    files: ["apps/web/src/server/runtime.ts"],
    reason:
      "Composition root of the Worker: builds `DatabaseLive` and `JobDatabaseLive` per request, delivery and job scope.",
  },
  {
    allows: ["db"],
    files: ["tools/prototype/seedProvider.ts"],
    reason:
      "Synthetic local prototype seed uses the existing database test-client boundary.",
  },
  {
    allows: ["db"],
    files: ["tools/prototype/provisionRuntime.ts"],
    reason:
      "Synthetic bootstrap applies runtime role grants and verifies its database login.",
  },
  {
    allows: ["db", "sql-pg", "drizzle"],
    files: ["tools/preview/bootstrap.ts"],
    reason:
      "Hosted synthetic branch bootstrap owns migration, seed and least-privilege runtime provisioning.",
  },
  {
    allows: ["sql-pg"],
    files: ["tools/preview/verify.ts"],
    reason:
      "Hosted preview verification cleans up only its owned synthetic CMS fixture through a scoped PostgreSQL client.",
  },
  {
    allows: ["db"],
    files: ["apps/web/test/auth.supabase.test.ts"],
    reason:
      "Native Auth integration compares a real SDK identity and session with restricted database projections.",
  },
  {
    allows: adapterTest,
    files: ["apps/web/test/*.postgres.test.ts"],
    reason:
      "Adapter tests: each builds the real database Layer against a disposable PostgreSQL (spec 0017, resolution 1).",
  },
  {
    allows: ["db"],
    files: [
      "apps/web/test/support/commandOutcome.ts",
      "apps/web/test/support/deliveryLive.ts",
      "apps/web/test/support/diagnosticRoute.ts",
      "apps/web/test/support/workspaceDatabase.ts",
    ],
    reason:
      "Test support that builds the real database Layer for the adapter tests above.",
  },
  {
    allows: ["sql-pg"],
    files: [
      "apps/web/e2e/support/probes.ts",
      "apps/web/e2e/support/publicFile.ts",
    ],
    reason:
      "Browser-test probes read and seed domain tables with raw SQL; they become adapter tests or use the ports in ADR 0014 stages 3 and 4.",
  },
  {
    allows: groups,
    files: ["tools/db-path-spike/**"],
    reason:
      "Slice 0000 harness: it checks Worker, Hyperdrive, `@effect/sql-pg` and Drizzle on the real platform, so it is an adapter-level test by design.",
  },
  {
    allows: ["db", "sql-pg"],
    files: ["tools/import/test/roundTrip.test.ts"],
    reason:
      "Round trip from real MySQL to a disposable PostgreSQL: an adapter test of `ImportTarget`.",
  },
  {
    allows: ["db"],
    files: ["tools/oxlint/anti-slop/rules/no-owned-table-write.ts"],
    reason:
      "The rule reads the adapter's ownership declaration; ADR 0014 stage 5 moves that declaration into the domain. Oxlint does not lint this directory, so the check is what covers it.",
  },
  {
    allows: ["db"],
    files: [
      "tools/import/src/pipeline.ts",
      "tools/import/src/emdash/pipeline.ts",
    ],
    reason:
      "Composition root of the importer: builds `ImportDatabaseLive`, the one place that names the adapter.",
  },
  {
    allows: ["db"],
    files: ["tools/docgen/src/databasePlatforms.ts"],
    reason:
      "The generated platform page reads the adapter's declaration of its platforms (plain data in `apps/web/src/adapters/db/platform/`, no client and no connection; spec 0025).",
  },
];

/** Direct adapter-path spellings for lint; the repository scan also resolves relative imports. */
export const siblingAdapterPattern = {
  message: restricted.db.message,
  regex: String.raw`(?:^|/)adapters/db(?:/|$)`,
};

const escape = (text: string): string =>
  text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

/** A path segment pattern: `*` matches anything but a slash. */
const star = (part: string): string =>
  Arr.join(Arr.map(part.split("*"), escape), "[^/]*");

/** A path glob as a regular expression: `**` crosses slashes (`**` and a slash match any number of directories), `*` does not. */
export const globToRegExp = (glob: string): RegExp => {
  const source = Arr.join(
    Arr.map(glob.split("**/"), (part) =>
      Arr.join(Arr.map(part.split("**"), star), ".*")
    ),
    "(?:.*/)?"
  );

  return new RegExp(`^${source}$`, "u");
};

export const groupOf = (specifier: string): Option.Option<Group> =>
  Arr.findFirst(allGroups, (group) =>
    Arr.some(restricted[group].regexes, (regex) =>
      new RegExp(regex, "u").test(specifier)
    )
  );

export const coveredBy = (path: string): readonly Allowance[] =>
  Arr.filter(allowances, (allowance) =>
    Arr.some(allowance.files, (glob) => globToRegExp(glob).test(path))
  );

/** What Oxlint's `no-restricted-imports` takes for a module pattern. */
interface Pattern {
  readonly message: string;
  readonly regex: string;
}

/**
 * Oxlint's `no-restricted-imports` patterns for a file that may import `allowed`: every other group, then whatever the
 * caller restricts everywhere (workspace source paths).
 */
export const restrictedImportPatterns = (
  allowed: readonly Group[],
  everywhere: readonly Pattern[]
): Pattern[] => {
  const denied = Arr.filter(allGroups, (group) => !allowed.includes(group));

  return [
    ...Arr.flatMap(denied, (group) =>
      Arr.map(restricted[group].regexes, (regex) => ({
        message: restricted[group].message,
        regex,
      }))
    ),
    ...everywhere,
  ];
};

/** One Oxlint override per allowance: the files it covers get the patterns of every group it does not allow. */
export const boundaryOverrides = (everywhere: readonly Pattern[]) =>
  Arr.map(allowances, (allowance) => ({
    files: [...allowance.files],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: restrictedImportPatterns(allowance.allows, everywhere) },
      ] satisfies ["error", { patterns: Pattern[] }],
    },
  }));
