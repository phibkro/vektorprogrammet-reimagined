import { eslintCompatPlugin } from "vite-plus/lint/plugins";

import { noArrayFilterMapRule } from "./rules/no-array-filter-map.ts";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noConditionalEmptyObjectSpreadRule } from "./rules/no-conditional-empty-object-spread.ts";
import { noDevServerRule } from "./rules/no-dev-server.ts";
import { noImplicitDateTimeZoneRule } from "./rules/no-implicit-date-time-zone.ts";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noMultiStatementUnsafeRule } from "./rules/no-multi-statement-unsafe.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noOwnedTableWriteRule } from "./rules/no-owned-table-write.ts";
import { noReduceAccumulatorCopyRule } from "./rules/no-reduce-accumulator-copy.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noReflectGetRule } from "./rules/no-reflect-get.ts";
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.ts";
import { noForbiddenTermInSymbolNamesRule } from "./rules/no-shape-in-symbol-names.ts";
import { noUnkeyedCommandRowRule } from "./rules/no-unkeyed-command-row.ts";
import { noUnknownParametersRule } from "./rules/no-unknown-parameters.ts";
import { noUnknownReturnsRule } from "./rules/no-unknown-returns.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";
import { requireReadableSpacingRule } from "./rules/require-readable-spacing.ts";
import { requireSafetyCommentForTypeAssertionRule } from "./rules/require-safety-comment-for-type-assertion.ts";

/** Generic Oxlint rules that reject low-evidence and low-signal implementation patterns. */
const antiSlopPlugin = eslintCompatPlugin({
  meta: { name: "vektor-anti-slop" },
  rules: {
    "no-array-filter-map": noArrayFilterMapRule,
    "no-reduce-accumulator-copy": noReduceAccumulatorCopyRule,
    "no-chained-type-assertions": noChainedTypeAssertionsRule,
    "no-conditional-empty-object-spread": noConditionalEmptyObjectSpreadRule,
    "no-dev-server": noDevServerRule,
    "no-implicit-date-time-zone": noImplicitDateTimeZoneRule,
    "no-known-value-widening": noKnownValueWideningRule,
    "no-module-mocking": noModuleMockingRule,
    "no-multi-statement-unsafe": noMultiStatementUnsafeRule,
    "no-object-parameters": noObjectParametersRule,
    "no-owned-table-write": noOwnedTableWriteRule,
    "no-reflect-apply": noReflectApplyRule,
    "no-reflect-get": noReflectGetRule,
    "no-runtime-typeof": noRuntimeTypeofRule,
    "no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
    "no-shape-in-symbol-names": noForbiddenTermInSymbolNamesRule,
    "no-unknown-parameters": noUnknownParametersRule,
    "no-unkeyed-command-row": noUnkeyedCommandRowRule,
    "no-unknown-returns": noUnknownReturnsRule,
    "no-unknown-type-aliases": noUnknownTypeAliasesRule,
    "no-widen-then-assert": noWidenThenAssertRule,
    "require-readable-spacing": requireReadableSpacingRule,
    "require-safety-comment-for-type-assertion":
      requireSafetyCommentForTypeAssertionRule,
  },
});

export default antiSlopPlugin;
