/**
 * The generated blocks of `docs/system/database-platforms.md` (spec 0025): what the domain asks of a platform, how the
 * PostgreSQL adapter answers on Hyperdrive, what only a direct connection has, and the connection profiles. Pure, like the
 * other renderers: the two declarations go in, the page comes out, and the check compares it with the committed one.
 *
 * The domain's side is `PlatformRequirements`; the adapter's side is `@vektorprogrammet/db/platform/*` (plain data, no
 * client). The `pg-txmode` column is a pointer into an unmerged catalogue and says so in its header.
 */
import { constructFacts } from "@vektorprogrammet/db/platform/constructs";
import type {
  Cell,
  Construct,
  ConstructFact,
} from "@vektorprogrammet/db/platform/constructs";
import { evidence } from "@vektorprogrammet/db/platform/evidence";
import {
  direct,
  directOnly,
  hyperdrive,
  otherConsumers,
} from "@vektorprogrammet/db/platform/profiles";
import type { ConnectionProfile } from "@vektorprogrammet/db/platform/profiles";
import { recipes } from "@vektorprogrammet/db/platform/recipes";
import { PlatformRequirements, isProbed } from "@vektorprogrammet/domain";
import type {
  Capability,
  CapabilityRequirement,
} from "@vektorprogrammet/domain";
import { Array as Arr, Record as Rec } from "effect";
import type { Result } from "effect";

import { checkRendered, replaceBlocks, table } from "./render.ts";

/** What the page is made of: the real declarations, or changed ones in the tests that show a changed declaration changes it. */
export interface PlatformDeclarations {
  readonly requirements: Readonly<Record<Capability, CapabilityRequirement>>;
  readonly recipes: Readonly<Record<Capability, readonly Construct[]>>;
  readonly facts: Readonly<Record<Construct, ConstructFact>>;
  /** Where each capability is shown or measured: the adapter's to say. */
  readonly evidence: Readonly<Record<Capability, string>>;
  readonly directOnly: readonly Construct[];
  readonly profiles: readonly ConnectionProfile<Construct>[];
  readonly others: readonly { readonly name: string; readonly where: string }[];
}

export const PLATFORMS: PlatformDeclarations = {
  directOnly,
  evidence,
  facts: constructFacts,
  others: otherConsumers,
  profiles: [hyperdrive, direct],
  recipes,
  requirements: PlatformRequirements,
};

const cellText = (cell: Cell): string =>
  `${cell.outcome} (${cell.how}): ${cell.note}`;

const asks = (declared: PlatformDeclarations): string => {
  const probed = Arr.flatMap(
    Rec.toEntries(declared.requirements),
    ([capability, requirement]) =>
      isProbed(requirement)
        ? Arr.map(requirement.checks, (check) => [
            capability,
            check.guarantee,
            `\`${check.id}\``,
            check.property,
            declared.evidence[capability],
          ])
        : []
  );

  const elsewhere = Arr.flatMap(
    Rec.toEntries(declared.requirements),
    ([capability, requirement]) =>
      isProbed(requirement) && requirement.shownElsewhere !== undefined
        ? [[capability, requirement.shownElsewhere]]
        : []
  );

  const notProbed = Arr.flatMap(
    Rec.toEntries(declared.requirements),
    ([capability, requirement]) =>
      isProbed(requirement)
        ? []
        : [[capability, requirement.reason, declared.evidence[capability]]]
  );

  return Arr.join(
    [
      "### Shown on every Preview by `GET /api/platform`",
      table(
        [
          "Capability",
          "Guarantee",
          "Check",
          "The platform must show",
          "Evidence",
        ],
        probed
      ),
      "### Shown by another port",
      table(["Capability", "Where"], elsewhere),
      "### Not shown by a deployed probe",
      table(["Capability", "Why not", "Evidence"], notProbed),
    ],
    "\n\n"
  );
};

const constructRow = (
  name: Construct,
  fact: ConstructFact
): readonly string[] => [
  `\`${name}\``,
  fact.summary,
  cellText(fact.direct),
  cellText(fact.hyperdrive),
  fact.pgTxmodeRow === undefined ? "none" : `\`${fact.pgTxmodeRow}\``,
];

const recipesBlock = (declared: PlatformDeclarations): string => {
  const used = Arr.dedupe(Arr.flatten(Rec.values(declared.recipes)));

  return Arr.join(
    [
      table(
        ["Capability", "Constructs of the adapter"],
        Arr.map(Rec.toEntries(declared.recipes), ([capability, constructs]) => [
          capability,
          constructs.length === 0
            ? "none of its own"
            : Arr.join(
                Arr.map(constructs, (construct) => `\`${construct}\``),
                ", "
              ),
        ])
      ),
      table(
        [
          "Construct",
          "What",
          "Direct",
          "Hyperdrive",
          "`pg-txmode` row (unmerged)",
        ],
        Arr.map(used, (construct) =>
          constructRow(construct, declared.facts[construct])
        )
      ),
    ],
    "\n\n"
  );
};

const directOnlyBlock = (declared: PlatformDeclarations): string =>
  table(
    ["Construct", "What", "Direct", "Hyperdrive", "`pg-txmode` row (unmerged)"],
    Arr.map(declared.directOnly, (construct) =>
      constructRow(construct, declared.facts[construct])
    )
  );

const profilesBlock = (declared: PlatformDeclarations): string =>
  Arr.join(
    [
      table(
        [
          "Profile",
          "Pooling",
          "Statements",
          "Multiplex",
          "Pool size",
          "Allows",
        ],
        Arr.map(declared.profiles, (profile) => [
          `\`${profile.name}\``,
          profile.pooling,
          profile.client.prepare ? "named" : "unnamed (`prepare: false`)",
          profile.client.multiplex ? "yes" : "no",
          String(profile.client.maxConnections),
          `${profile.allows.length} constructs`,
        ])
      ),
      table(
        ["Profile", "Setting", "Why"],
        Arr.flatMap(declared.profiles, (profile) =>
          Arr.map(Rec.toEntries(profile.why), ([setting, why]) => [
            `\`${profile.name}\``,
            `\`${setting}\``,
            why,
          ])
        )
      ),
      "Clients that reach Hyperdrive and are not built from a profile:",
      table(
        ["Client", "Where"],
        Arr.map(declared.others, ({ name, where }) => [name, where])
      ),
    ],
    "\n\n"
  );

export const renderDatabasePlatformsDocument = (
  document: string,
  declared: PlatformDeclarations = PLATFORMS
): Result.Result<string, string> =>
  replaceBlocks(document, [
    ["asks", asks(declared)],
    ["recipes", recipesBlock(declared)],
    ["direct-only", directOnlyBlock(declared)],
    ["profiles", profilesBlock(declared)],
  ]);

export const checkDatabasePlatformsDocument = (
  document: string,
  declared: PlatformDeclarations = PLATFORMS
): Result.Result<void, string> =>
  checkRendered(document, renderDatabasePlatformsDocument(document, declared));
