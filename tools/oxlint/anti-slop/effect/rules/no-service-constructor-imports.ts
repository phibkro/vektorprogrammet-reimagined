import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

const SERVICE_CONSTRUCTOR_NAME = /^make[A-Z]/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const TEST_SUPPORT = /(?:^|\/)test\/(?:[^/]+\/)*support\//u;

function isProjectLocalImport(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

function getImportedName(specifier: ESTree.ImportSpecifier): string {
  if (specifier.imported.type === "Identifier") return specifier.imported.name;
  return specifier.imported.value;
}

/** Keep dependency-bearing Effect service constructors local to their owning capability modules. */
export const noServiceConstructorImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow project-local make<CapabilityName> imports outside tests and test support.",
    },
    messages: {
      serviceConstructorImport:
        'Do not import Effect service constructor "{{name}}" into runtime code. Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root.',
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    const isTestFile = TEST_FILE.test(filename) || TEST_SUPPORT.test(filename);

    return {
      ImportDeclaration(node) {
        if (isTestFile || !isProjectLocalImport(node.source.value)) return;

        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;

          const importedName = getImportedName(specifier);
          if (!SERVICE_CONSTRUCTOR_NAME.test(importedName)) continue;

          context.report({
            node: specifier,
            messageId: "serviceConstructorImport",
            data: { name: importedName },
          });
        }
      },
    };
  },
});
