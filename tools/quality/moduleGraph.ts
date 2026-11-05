/**
 * The module graph of the repository (ADR 0015, stage 1; spec 0020).
 *
 * One declaration of what may import what, in two levels, and `checkModuleGraph.ts` reads it (as `storeBoundary.ts` is
 * read by its check and by the lint):
 *
 * - **Modules** partition the shared and feature domain source trees. Each has a layer and declared dependencies.
 * - **Units** separate the application from tools; tools may use direct application paths.
 * The baseline lists tolerated violations and fails when an entry becomes unnecessary.
 */
export type Layer = "library" | "service" | "catalog" | "privacy" | "assembly";

/** A module may import a module of its own layer or a lower one (ADR 0015, section 2). */
export const layerRank: Readonly<Record<Layer, number>> = {
  assembly: 4,
  catalog: 2,
  library: 0,
  privacy: 3,
  service: 1,
};

export interface Module {
  readonly name: string;
  readonly layer: Layer;
  /** Paths from the repository root; `*` stops at a slash and `**` crosses slashes. */
  readonly files: readonly string[];
  /** Files that the globs match and the module does not own (another module lists them). */
  readonly except?: readonly string[];
  /** The modules whose files this one may import; `"all"` for the assembly, which composes every module. */
  readonly uses: readonly string[] | "all";
  /** External packages beyond `effect` that the module may import. */
  readonly packages?: readonly string[];
}

/** A unit is a workspace package: `packages/domain`, `apps/web`, `tools/quality`. */
export interface Unit {
  readonly root: string;
  /** The units whose package this one may import. */
  readonly uses: readonly string[];
  /** Paths in this unit that tools may import directly. */
  readonly toolPaths?: readonly string[];
}

/** An import that breaks a rule today and is tolerated until a stage of the ADR removes it. */
export interface Tolerated {
  /** The importing file, from the repository root. */
  readonly from: string;
  /** The imported file (a module edge) or the imported unit (a unit edge). */
  readonly to: string;
  readonly reason: string;
}

/** A method of a service, as a file reaches it: it binds the service (`const sender = yield* MessageSender`) and calls `sender.send(…)`. */
export interface ServiceMethod {
  readonly method: string;
  readonly service: string;
}

/** A call of another system inside a transaction that the type bound cannot see, tolerated until `retirementTrigger`. */
interface IntegrationCall {
  readonly file: string;
  /** The call, by the service its receiver is bound to in `file`, not by the receiver's name: `MessageSender.send`. */
  readonly call: ServiceMethod;
  /** The call that runs the transaction, whose arguments hold `call`: `Transactor.run`. */
  readonly within: ServiceMethod;
  readonly reason: string;
  readonly retirementTrigger: string;
}

export interface Declaration {
  /** The files that the modules partition: every source file under it is a `.ts` file of exactly one module. */
  readonly governed: readonly string[];
  readonly modules: readonly Module[];
  readonly units: readonly Unit[];
  /** Files in which an import cycle fails, the same files for which the root `vite.config.ts` turns on `import/no-cycle`. */
  readonly acyclic: readonly string[];
  /** Generated type-only edges excluded from cycle traversal. */
  readonly acyclicTypeEdges?: readonly (readonly [string, string])[];
  readonly baseline: readonly Tolerated[];
  readonly integrationCalls: readonly IntegrationCall[];
}

const modules: readonly Module[] = [
  {
    files: [
      "apps/web/src/features/cms/domain/client.ts",
      "apps/web/src/features/cms/domain/collections.ts",
      "apps/web/src/features/cms/domain/portableText.ts",
    ],
    layer: "library",
    name: "cms",
    uses: [],
  },
  {
    files: [
      "apps/web/src/core/ids.ts",
      "apps/web/src/core/errors.ts",
      "apps/web/src/core/validation.ts",
      "apps/web/src/core/clock.ts",
      "apps/web/src/core/siteOrigin.ts",
      "apps/web/src/features/organisation/domain/semester.ts",
      "apps/web/src/core/kernel/principal.ts",
    ],
    layer: "library",
    name: "vocabulary",
    uses: [],
  },
  {
    files: [
      "apps/web/src/core/kernel/authorize.ts",
      "apps/web/src/core/kernel/commands.ts",
      "apps/web/src/core/kernel/domain.ts",
      "apps/web/src/core/kernel/effx.ts",
      "apps/web/src/core/kernel/grant.ts",
      "apps/web/src/core/kernel/guard.ts",
      "apps/web/src/core/kernel/machine.ts",
      "apps/web/src/core/kernel/subject.ts",
    ],
    layer: "library",
    name: "kernel",
    uses: ["transactions", "vocabulary"],
  },
  {
    files: [
      "apps/web/src/core/transactions/transaction.ts",
      "apps/web/src/core/transactions/integrationGuard.ts",
      "apps/web/src/core/transactions/transactor.ts",
      "apps/web/src/core/transactions/aggregate.ts",
      "apps/web/src/core/store/isolationProbe.ts",
      "apps/web/src/core/store/platformProbe.ts",
    ],
    layer: "library",
    name: "transactions",
    uses: ["vocabulary"],
  },
  {
    files: ["apps/web/src/core/outbox/outbox.ts"],
    layer: "library",
    name: "outbox",
    uses: ["transactions", "vocabulary"],
  },
  {
    files: [
      "apps/web/src/features/personal-data/domain/declaration.ts",
      "apps/web/src/features/personal-data/domain/duration.ts",
      "apps/web/src/features/personal-data/domain/forms.ts",
      "apps/web/src/features/personal-data/domain/periods.ts",
      "apps/web/src/features/personal-data/domain/retentions.ts",
      "apps/web/src/features/personal-data/domain/consents.ts",
      "apps/web/src/features/personal-data/domain/retentionEnd.ts",
      "apps/web/src/features/personal-data/domain/texts.ts",
    ],
    layer: "library",
    name: "annotations",
    uses: ["vocabulary"],
  },
  {
    files: ["apps/web/src/features/audit/domain/*.ts"],
    layer: "service",
    name: "audit",
    uses: ["annotations", "kernel", "transactions", "vocabulary"],
  },
  {
    files: ["apps/web/src/features/files/domain/*.ts"],
    layer: "service",
    name: "files",
    uses: ["annotations", "audit", "kernel", "transactions", "vocabulary"],
  },
  {
    files: [
      "apps/web/src/features/cms/domain/article.ts",
      "apps/web/src/features/cms/domain/sanitizer.ts",
      "apps/web/src/features/cms/domain/slug.ts",
      "apps/web/src/features/cms/domain/sponsor.ts",
      "apps/web/src/features/events/domain/*.ts",
    ],
    layer: "service",
    name: "content",
    packages: ["sanitize-html"],
    uses: ["annotations", "audit", "kernel", "transactions", "vocabulary"],
  },
  {
    except: ["apps/web/src/features/organisation/domain/semester.ts"],
    files: ["apps/web/src/features/organisation/domain/*.ts"],
    layer: "service",
    name: "organisation",
    uses: [
      "annotations",
      "audit",
      "files",
      "kernel",
      "outbox",
      "transactions",
      "vocabulary",
    ],
  },
  {
    files: ["apps/web/src/features/contact/domain/*.ts"],
    layer: "service",
    name: "contact",
    uses: [
      "annotations",
      "kernel",
      "organisation",
      "outbox",
      "transactions",
      "vocabulary",
    ],
  },
  {
    files: [
      "apps/web/src/features/teams/domain/*.ts",
      "apps/web/src/features/workspace/domain/companyEmail.ts",
    ],
    layer: "service",
    name: "membership",
    uses: [
      "annotations",
      "audit",
      "kernel",
      "organisation",
      "outbox",
      "transactions",
      "vocabulary",
    ],
  },
  {
    files: ["apps/web/src/features/accounts/domain/*.ts"],
    layer: "service",
    name: "iam",
    uses: [
      "annotations",
      "audit",
      "kernel",
      "membership",
      "outbox",
      "transactions",
      "vocabulary",
    ],
  },
  {
    except: [
      "apps/web/src/core/outbox/delivery.ts",
      "apps/web/src/core/outbox/messages.ts",
      "apps/web/src/core/outbox/outbox.ts",
    ],
    files: [
      "apps/web/src/core/jobs/job.ts",
      "apps/web/src/core/jobs/runs.ts",
      "apps/web/src/core/jobs/problems.ts",
      "apps/web/src/core/jobs/personalData.ts",
      "apps/web/src/core/outbox/*.ts",
    ],
    layer: "service",
    name: "triggers",
    uses: [
      "annotations",
      "iam",
      "kernel",
      "outbox",
      "transactions",
      "vocabulary",
    ],
  },
  {
    except: ["apps/web/src/features/workspace/domain/companyEmail.ts"],
    files: ["apps/web/src/features/workspace/domain/*.ts"],
    layer: "service",
    name: "workspace",
    uses: [
      "annotations",
      "audit",
      "kernel",
      "membership",
      "outbox",
      "transactions",
      "triggers",
      "vocabulary",
    ],
  },
  {
    files: ["apps/web/src/features/impact/domain/*.ts"],
    layer: "service",
    name: "impact",
    uses: ["annotations", "kernel", "organisation", "triggers", "vocabulary"],
  },
  {
    files: ["apps/web/src/features/admission/domain/*.ts"],
    layer: "service",
    name: "admission",
    uses: [
      "annotations",
      "audit",
      "iam",
      "kernel",
      "membership",
      "organisation",
      "outbox",
      "transactions",
      "vocabulary",
    ],
  },
  {
    files: [
      "apps/web/src/features/personal-data/domain/catalog.ts",
      "apps/web/src/core/jobs/registry.ts",
      "apps/web/src/core/outbox/delivery.ts",
      "apps/web/src/core/outbox/messages.ts",
    ],
    layer: "catalog",
    name: "catalog",
    uses: [
      "admission",
      "annotations",
      "audit",
      "contact",
      "content",
      "files",
      "iam",
      "impact",
      "membership",
      "organisation",
      "outbox",
      "transactions",
      "triggers",
      "vocabulary",
      "workspace",
    ],
  },
  {
    files: [
      "apps/web/src/features/personal-data/domain/alumni.ts",
      "apps/web/src/features/personal-data/domain/commands.ts",
      "apps/web/src/features/personal-data/domain/derive.ts",
      "apps/web/src/features/personal-data/domain/notice.ts",
      "apps/web/src/features/personal-data/domain/rpc.ts",
      "apps/web/src/features/personal-data/domain/services.ts",
    ],
    layer: "privacy",
    name: "privacy",
    uses: [
      "annotations",
      "audit",
      "catalog",
      "files",
      "iam",
      "kernel",
      "membership",
      "outbox",
      "transactions",
      "vocabulary",
    ],
  },
  {
    files: [
      "apps/web/src/core/declarations.ts",
      "apps/web/src/core/store/guarantees.ts",
      "apps/web/src/core/store/platformRequirements.ts",
      "apps/web/src/core/store/transactionModes.ts",
    ],
    layer: "assembly",
    name: "assembly",
    uses: "all",
  },
];

/** The application and each tool remain separate units. */
const units: readonly Unit[] = [
  {
    root: "apps/web",
    toolPaths: [
      "apps/web/src/core/**",
      "apps/web/src/features/*/domain/**",
      "apps/web/src/adapters/db/**",
      "apps/web/test/fixtures/**",
      "apps/web/test/domain/support/**",
      "apps/web/test/db/support/**",
      "apps/web/worker.config.ts",
    ],
    uses: [],
  },
  { root: "tools/quality", uses: [] },
  { root: "tools/docgen", uses: [] },
  { root: "tools/effx-conformance", uses: [] },
  { root: "tools/oxlint", uses: [] },
  { root: "tools/import", uses: [] },
  { root: "tools/prototype", uses: [] },
  { root: "tools/db-path-spike", uses: [] },
];

/** Violations still tolerated by the ratchet. */
export const baseline: readonly Tolerated[] = [];

/**
 * The calls of another system that still run inside `Transactor.run` although the type bound (`NotAnIntegration`) does
 * not see them: a port captured when a Layer is built is not a requirement of the program that uses it. Each is
 * tolerated until its retirement trigger. An entry names the call by the services its receivers are bound to in the file
 * (`const sender = yield* MessageSender`; `call` inside `within`), and the check fails when the file no longer has that
 * call inside that one, so the restructure that moves the call out of the transaction retires the entry, a renamed
 * variable does not, and the list can only shrink (spec 0020, review rounds 1 to 3).
 *
 * It is empty since spec 0024: code delivery stores the code unusable, sends after the commit and makes the code usable
 * in a second transaction, and every integration port refuses a call made while a transaction is open
 * (`refusingInTransaction`), so a call that the type bound cannot see dies at run time instead of being listed here.
 */
const integrationCalls: readonly IntegrationCall[] = [];

export const declaration: Declaration = {
  acyclic: ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"],
  // TanStack generates the route tree and router.tsx registers its type against it.
  acyclicTypeEdges: [
    ["apps/web/src/routeTree.gen.ts", "apps/web/src/router.tsx"],
  ],
  baseline,
  governed: ["apps/web/src/core/**", "apps/web/src/features/*/domain/**"],
  integrationCalls,
  modules,
  units,
};
