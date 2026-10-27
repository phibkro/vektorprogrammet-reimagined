/** What the sidebar offers a principal, as the section keys of its items in the sidebar's order. */
import type { Principal } from "@vektorprogrammet/domain";
import { Array as Arr } from "effect";

import type { SectionKey } from "../../src/lib/panelSections";
import { navigationFor } from "../../src/server/shell";

export const sectionsOf = (principal: Principal): readonly SectionKey[] =>
  Arr.flatMap(navigationFor(principal), (group) =>
    Arr.map(group.items, (item) => item.key)
  );
