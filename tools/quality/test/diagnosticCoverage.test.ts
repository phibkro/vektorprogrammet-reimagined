import { effectNative, strict } from "@effect/tsgo/oxlint-presets";
import { describe, it } from "@effect/vitest";
import { Array as Arr, Option, Record as Rec, String as Str } from "effect";
import { expect } from "vite-plus/test";

import oxlintSchema from "../../../node_modules/@effect/tsgo/oxlint-schema.json" with { type: "json" };
import schema from "../../../node_modules/@effect/tsgo/schema.json" with { type: "json" };
import config from "../../../tsconfig.json" with { type: "json" };
import { tsgoRules } from "../../../vite.config.ts";

const available = Object.getOwnPropertyNames(
  oxlintSchema.definitions.DummyRuleMap.properties
);

const defaults =
  schema.definitions.effectLanguageServicePluginDiagnosticSeverityDefinition
    .properties;

const editor = config.compilerOptions.plugins.at(0)?.diagnosticSeverity ?? {};

const checkRule = (name: string, severity: string) => {
  const match = Arr.findFirst(
    available,
    (key) =>
      Str.startsWith("effecttsgo/")(key) &&
      Str.replaceAll("-", "")(Str.slice(11)(key)) === Str.toLowerCase(name)
  );

  const rule = Option.getOrThrow(match);

  const selected =
    severity !== "off" ||
    rule in (strict.rules ?? {}) ||
    rule in (effectNative.rules ?? {});

  const expected = selected ? "error" : undefined;

  const editorSeverity: unknown = Object.getOwnPropertyDescriptor(
    editor,
    name
  )?.value;

  expect(tsgoRules[rule], rule).toBe(expected);
  expect(editorSeverity, name).toBe(expected);
};

describe("Effect diagnostic coverage", () => {
  it("sets every default-on rule and selected preset rule to error", () => {
    for (const [name, definition] of Rec.toEntries(defaults)) {
      checkRule(name, definition.default);
    }
  });
});
