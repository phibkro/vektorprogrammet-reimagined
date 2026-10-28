/**
 * Where the store adapter and the database engine packages may be imported (spec 0017, ADR 0014 stage 1).
 *
 * `@vektorprogrammet/db` is the PostgreSQL adapter. Code outside it asks for a capability from `@vektorprogrammet/domain`
 * (a port) and a composition root provides the adapter's Layer. This module is the one declaration of that rule:
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

export type Group = "db" | "drizzle" | "pg" | "sql-pg";

interface Restriction {
  readonly message: string;
  /** Regular expressions over a module specifier (the Rust and the JavaScript syntax agree on these). */
  readonly regexes: readonly string[];
}

const restricted: Readonly<Record<Group, Restriction>> = {
  db: {
    message:
      "`@vektorprogrammet/db` is the PostgreSQL adapter: code outside it asks for a port that `@vektorprogrammet/domain` declares, and a composition root provides the adapter's Layer (spec 0017).",
    regexes: ["^@vektorprogrammet/db(?:/|$)", "(?:^|/)packages/db(?:/|$)"],
  },
  drizzle: {
    message:
      "Drizzle is an adapter detail of `packages/db`: go through a domain port (spec 0017).",
    regexes: ["^drizzle-orm(?:/|$)"],
  },
  pg: {
    message:
      "`pg` is the PostgreSQL driver: only Better Auth's own adapter (`apps/web/src/server/auth.ts`) and adapter tests use it (spec 0017).",
    regexes: ["^pg(?:/|$)"],
  },
  "sql-pg": {
    message:
      "`@effect/sql-pg` is the PostgreSQL client of `packages/db`: go through a domain port (spec 0017).",
    regexes: ["^@effect/sql-pg(?:lite)?(?:/|$)"],
  },
};

const groups: readonly Group[] = Rec.keys(restricted);

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
    files: ["packages/db/**"],
    reason: "The adapter itself.",
  },
  {
    allows: ["db"],
    files: ["apps/web/src/server/runtime.ts"],
    reason:
      "Composition root of the Worker: builds `DatabaseLive` and `JobDatabaseLive` per request, delivery and job scope.",
  },
  {
    allows: ["pg"],
    files: ["apps/web/src/server/auth.ts"],
    reason:
      "Better Auth's own `pg` adapter (ADR 0014, answer 4; exception EX-0017). It reads no domain table.",
  },
  {
    allows: adapterTest,
    files: [
      "apps/web/test/**/*.postgres.test.ts",
      "apps/web/test/**/*.worker.test.ts",
    ],
    reason:
      "Adapter tests: each builds the real database Layer against a disposable PostgreSQL (spec 0017, resolution 1).",
  },
  {
    allows: ["db"],
    files: [
      "apps/web/test/support/commandOutcome.ts",
      "apps/web/test/support/deliveryLive.ts",
      "apps/web/test/support/outboxQueue.worker.ts",
      "apps/web/test/support/workspaceDatabase.ts",
    ],
    reason:
      "Test support that builds the real database Layer for the adapter tests above.",
  },
  {
    allows: ["db"],
    files: ["apps/web/e2e/support/database.ts"],
    reason: "Browser-test harness: creates and migrates a disposable database.",
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
    allows: ["db"],
    files: ["apps/cms/scripts/checkBundle.ts"],
    reason: "Bundle check: creates a disposable database for the CMS Worker.",
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
    files: ["tools/import/src/pipeline.ts"],
    reason:
      "Composition root of the importer: builds `ImportDatabaseLive`, the one place that names the adapter.",
  },
];

/**
 * A package beside `packages/db` reaches it as `../../db/…`, a specifier with no `packages/` in it. Oxlint cannot resolve
 * a path, so the lint restricts that spelling in `packages/**`, where `..` leads to `packages/`; a `db` directory
 * elsewhere (`apps/cms/db`) is not the adapter. `checkStoreBoundary.ts` resolves every relative specifier against its
 * file and needs no pattern.
 */
export const siblingAdapterPattern = {
  message: restricted.db.message,
  regex: String.raw`^(?:\.\./)+db(?:/|$)`,
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
  Arr.findFirst(groups, (group) =>
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
  const denied = Arr.filter(groups, (group) => !allowed.includes(group));

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
