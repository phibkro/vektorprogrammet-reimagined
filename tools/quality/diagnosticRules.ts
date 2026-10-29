import { effectNative, strict } from "@effect/tsgo/oxlint-presets";
import { String as Str } from "effect";

import schema from "../../node_modules/@effect/tsgo/schema.json" with { type: "json" };

const hasKey = <T extends object>(
  object: T,
  key: PropertyKey
): key is keyof T => key in object;

const defaults =
  schema.definitions.effectLanguageServicePluginDiagnosticSeverityDefinition
    .properties;

const lint: Record<string, "error"> = {};
const editor: Record<string, "error"> = {};

for (const preset of [strict, effectNative]) {
  for (const rule of Object.getOwnPropertyNames(preset.rules ?? {})) {
    lint[rule] = "error";
  }
}

for (const name of Object.getOwnPropertyNames(defaults)) {
  if (!hasKey(defaults, name)) {
    continue;
  }

  const kebab = Str.toLowerCase(
    Str.replaceAll(
      /(?<left>[a-z0-9])(?<right>[A-Z])/gu,
      "$<left>-$<right>"
    )(
      Str.replaceAll(
        /(?<left>[A-Z]+)(?<right>[A-Z][a-z])/gu,
        "$<left>-$<right>"
      )(name)
    )
  );

  const rule = `effecttsgo/${kebab}`;

  if (defaults[name].default !== "off" || rule in lint) {
    lint[rule] = "error";
    editor[name] = "error";
  }
}

export const diagnosticRules = { editor, lint };
