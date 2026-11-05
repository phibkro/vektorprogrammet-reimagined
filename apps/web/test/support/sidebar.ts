import { Array as Arr } from "effect";

/** What the sidebar offers a principal, as the section keys of its items in the sidebar's order. */
import type { Principal } from "../../src/domain/kernel/principal";
import type { SectionKey } from "../../src/features/panel/panelSections";
import { navigationFor } from "../../src/features/panel/server/shell";

export const sectionsOf = (principal: Principal): readonly SectionKey[] =>
  Arr.flatMap(navigationFor(principal), (group) =>
    Arr.map(group.items, (item) => item.key)
  );
