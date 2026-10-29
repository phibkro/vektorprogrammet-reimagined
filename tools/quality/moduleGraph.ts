/**
 * The module graph of the repository (ADR 0015, stage 1; spec 0020).
 *
 * One declaration of what may import what, in two levels, and `checkModuleGraph.ts` reads it (as `storeBoundary.ts` is
 * read by its check and by the lint):
 *
 * - **Modules** inside `packages/domain/src`: a named group of files, by glob over today's layout, with a layer and the
 *   modules it may use. Layers order the modules (library < service < catalog < privacy < assembly): an import that
 *   points to a higher layer fails, and so does an import of a module that the importer does not declare. A module
 *   imports `effect` and the external packages its row names, and nothing else.
 * - **Units** (`packages/*`, `apps/*`, `tools/*`): the workspace package that a file belongs to, with the units it may
 *   import. The domain imports no workspace package, `packages/db` only the domain, nothing imports a tool or an app.
 *
 * Today's layout breaks some of these rules (ADR 0015, sections 2 and 3). Each such import is a `baseline` entry with
 * its reason, and the list can only shrink: an import that breaks a rule and is not on it fails, an entry that no import
 * needs fails, and `moduleGraph.test.ts` pins its length, so a stage that removes an import must lower the count. Stages
 * 2 to 5 of the ADR remove the entries.
 */
import { Array as Arr } from "effect";

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
export interface IntegrationCall {
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
  readonly governed: string;
  readonly modules: readonly Module[];
  readonly units: readonly Unit[];
  /** Files in which an import cycle fails, the same files for which the root `vite.config.ts` turns on `import/no-cycle`. */
  readonly acyclic: readonly string[];
  readonly baseline: readonly Tolerated[];
  readonly integrationCalls: readonly IntegrationCall[];
}

const src = (...files: readonly string[]): readonly string[] =>
  Arr.map(files, (file) => `packages/domain/src/${file}`);

const modules: readonly Module[] = [
  {
    files: src(
      "shared/ids.ts",
      "shared/errors.ts",
      "shared/validation.ts",
      "shared/clock.ts",
      "shared/siteOrigin.ts",
      "organisation/semester.ts",
      "kernel/principal.ts"
    ),
    layer: "library",
    name: "vocabulary",
    uses: [],
  },
  {
    files: src(
      "kernel/authorize.ts",
      "kernel/commands.ts",
      "kernel/domain.ts",
      "kernel/effx.ts",
      "kernel/grant.ts",
      "kernel/guard.ts",
      "kernel/machine.ts",
      "kernel/subject.ts"
    ),
    layer: "library",
    name: "kernel",
    uses: ["transactions", "vocabulary"],
  },
  {
    files: src(
      "shared/transaction.ts",
      "shared/transactor.ts",
      "shared/aggregate.ts",
      "shared/isolationProbe.ts"
    ),
    layer: "library",
    name: "transactions",
    uses: ["vocabulary"],
  },
  {
    files: src("shared/outbox.ts"),
    layer: "library",
    name: "outbox",
    uses: ["transactions", "vocabulary"],
  },
  {
    files: src(
      "personalData/declaration.ts",
      "personalData/duration.ts",
      "personalData/forms.ts",
      "personalData/periods.ts",
      "personalData/retentions.ts",
      "personalData/consents.ts",
      "personalData/retentionEnd.ts",
      "personalData/texts.ts"
    ),
    layer: "library",
    name: "annotations",
    uses: ["vocabulary"],
  },
  {
    files: src("audit/*.ts"),
    layer: "service",
    name: "audit",
    uses: ["annotations", "kernel", "transactions", "vocabulary"],
  },
  {
    files: src("files/*.ts"),
    layer: "service",
    name: "files",
    uses: ["annotations", "audit", "kernel", "transactions", "vocabulary"],
  },
  {
    files: src("content/*.ts"),
    layer: "service",
    name: "content",
    packages: ["sanitize-html"],
    uses: ["annotations", "audit", "kernel", "transactions", "vocabulary"],
  },
  {
    except: src("organisation/semester.ts"),
    files: src("organisation/*.ts"),
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
    files: src("contact/*.ts"),
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
    files: src("teams/*.ts", "workspace/companyEmail.ts"),
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
    files: src("accounts/*.ts"),
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
    except: src("outbox/delivery.ts", "outbox/messages.ts"),
    files: src(
      "jobs/job.ts",
      "jobs/runs.ts",
      "jobs/problems.ts",
      "jobs/personalData.ts",
      "outbox/*.ts"
    ),
    layer: "service",
    name: "triggers",
    uses: ["annotations", "kernel", "outbox", "transactions", "vocabulary"],
  },
  {
    except: src("workspace/companyEmail.ts"),
    files: src("workspace/*.ts"),
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
    files: src(
      "personalData/catalog.ts",
      "jobs/registry.ts",
      "outbox/delivery.ts",
      "outbox/messages.ts"
    ),
    layer: "catalog",
    name: "catalog",
    uses: [
      "annotations",
      "audit",
      "contact",
      "content",
      "files",
      "iam",
      "membership",
      "organisation",
      "outbox",
      "triggers",
      "vocabulary",
      "workspace",
    ],
  },
  {
    files: src(
      "personalData/alumni.ts",
      "personalData/commands.ts",
      "personalData/derive.ts",
      "personalData/notice.ts",
      "personalData/rpc.ts",
      "personalData/services.ts"
    ),
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
    files: src(
      "declarations.ts",
      "index.ts",
      "localPeople.ts",
      "shared/guarantees.ts",
      "shared/transactionModes.ts"
    ),
    layer: "assembly",
    name: "assembly",
    uses: "all",
  },
];

/**
 * `apps/*` compose the platform and import no other app; `tools/*` import a package's declarations and never an app
 * (ADR 0015, section 7). `tools/quality`'s tests read the domain's declarations to check them (`storePorts.test.ts`,
 * `inTransactionProviders.test.ts`), and the Slice 0000 harness `tools/db-path-spike` is an adapter-level test of the
 * database packages by design (`storeBoundary.ts` allows it the same imports).
 */
const units: readonly Unit[] = [
  { root: "packages/domain", uses: [] },
  { root: "packages/cms-client", uses: [] },
  { root: "packages/db", uses: ["packages/domain"] },
  {
    root: "apps/web",
    uses: ["packages/domain", "packages/db", "packages/cms-client"],
  },
  { root: "apps/cms", uses: [] },
  { root: "tools/quality", uses: ["packages/domain"] },
  { root: "tools/docgen", uses: ["packages/domain"] },
  { root: "tools/effx-conformance", uses: ["packages/domain"] },
  { root: "tools/oxlint", uses: [] },
  {
    root: "tools/import",
    uses: ["packages/domain", "packages/db", "packages/cms-client"],
  },
  { root: "tools/db-path-spike", uses: ["packages/db", "packages/domain"] },
];

/**
 * The imports that break a rule today (ADR 0015, sections 2, 3 and 9), each with the stage that removes it. The list can
 * only shrink; `moduleGraph.test.ts` pins its length. Stages 2 and 3 (spec 0022) removed the three imports between
 * modules; what is left are imports between packages (stage 5).
 */
export const baseline: readonly Tolerated[] = [
  {
    from: "apps/cms/scripts/checkBundle.ts",
    reason:
      "The bundle check makes a disposable database with `packages/db`'s test helper. Stage 5 (package rows).",
    to: "packages/db",
  },
  {
    from: "apps/cms/scripts/checkBundle.ts",
    reason:
      "The bundle check reads the web Worker's `worker.config.ts`, the compatibility settings both Workers share. Stage 5 moves it where both may import it.",
    to: "apps/web",
  },
  {
    from: "apps/web/test/textSlots.test.ts",
    reason:
      "The test reads the CMS seed (`../../cms/seed/seed.json`) to compare it with the text slots. Stage 5: the seed read goes through a package export.",
    to: "apps/cms",
  },
  {
    from: "tools/db-path-spike/alchemy.run.ts",
    reason:
      "The harness's Alchemy file reads `apps/web/worker.config.ts`. Stage 5: the harness stops importing `apps/web` or is deleted.",
    to: "apps/web",
  },
  {
    from: "tools/oxlint/anti-slop/rules/no-owned-table-write.ts",
    reason:
      "The rule reads the adapter's ownership declaration. ADR 0014 stage 5 moves that declaration into the domain.",
    to: "packages/db",
  },
];

/**
 * The calls of another system that still run inside `Transactor.run` although the type bound (`NotAnIntegration`) does
 * not see them: a port captured when a Layer is built is not a requirement of the program that uses it. Each is
 * tolerated until its retirement trigger. An entry names the call by the services its receivers are bound to in the file
 * (`const sender = yield* MessageSender`; `call` inside `within`), and the check fails when the file no longer has that
 * call inside that one, so the restructure that moves the mail out of the transaction retires the entry, a renamed
 * variable does not, and the list can only shrink (spec 0020, review rounds 1 to 3).
 */
export const integrationCalls: readonly IntegrationCall[] = [
  {
    call: { method: "send", service: "MessageSender" },
    file: "apps/web/src/server/accountDelivery.ts",
    reason:
      "`AccountDelivery.issueCode` mints a code, calls `MessageSender.send` and acknowledges the row in ONE transaction, so that the code is stored only if the mail went out (spec 0007 R1). The Layer captures the sender, so the bound does not see the call.",
    retirementTrigger:
      "code delivery restructured (next spec): code stored unusable, mail sent after commit, second transaction makes it usable; then integration adapters refuse calls while a transaction is open",
    within: { method: "run", service: "Transactor" },
  },
];

export const declaration: Declaration = {
  acyclic: ["packages/**/*.ts", "packages/**/*.tsx"],
  baseline,
  governed: "packages/domain/src/**",
  integrationCalls,
  modules,
  units,
};
