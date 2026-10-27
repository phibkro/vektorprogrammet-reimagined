import { effectNative, strict } from "@effect/tsgo/oxlint-presets";
import { describe, expect, it } from "vite-plus/test";

import schema from "../../../node_modules/@effect/tsgo/schema.json" with { type: "json" };
import config from "../../../tsconfig.json" with { type: "json" };
import { tsgoRules } from "../../../vite.config.ts";

const hasKey = <T extends object>(
  object: T,
  key: PropertyKey
): key is keyof T => key in object;

const defaults =
  schema.definitions.effectLanguageServicePluginDiagnosticSeverityDefinition
    .properties;

const editor = config.compilerOptions.plugins.at(0)?.diagnosticSeverity ?? {};

const checkRule = (name: string) => {
  if (!hasKey(defaults, name)) {
    return;
  }

  const kebab = name
    .replaceAll(/(?<left>[A-Z]+)(?<right>[A-Z][a-z])/gu, "$<left>-$<right>")
    .replaceAll(/(?<left>[a-z0-9])(?<right>[A-Z])/gu, "$<left>-$<right>")
    .toLowerCase();

  const rule = `effecttsgo/${kebab}`;

  const selected =
    defaults[name].default !== "off" ||
    rule in (strict.rules ?? {}) ||
    rule in (effectNative.rules ?? {});

  const expected = selected ? "error" : undefined;

  const editorSeverity = hasKey(editor, name) ? editor[name] : undefined;

  expect(tsgoRules[rule], rule).toBe(expected);
  expect(editorSeverity, name).toBe(expected);
};

describe("Effect diagnostic coverage", () => {
  it("sets every default-on rule and selected preset rule to error", () => {
    for (const name of Object.getOwnPropertyNames(defaults)) {
      checkRule(name);
    }
  });
});
