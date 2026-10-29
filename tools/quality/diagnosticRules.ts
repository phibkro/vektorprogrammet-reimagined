import { effectNative, strict } from "@effect/tsgo/oxlint-presets";

import schema from "../../node_modules/@effect/tsgo/schema.json" with { type: "json" };

const hasKey = <T extends object>(
  object: T,
  key: PropertyKey
): key is keyof T => key in object;

const defaults =
  schema.definitions.effectLanguageServicePluginDiagnosticSeverityDefinition
    .properties;

const lint: Record<string, "error" | "off"> = {};
const editor: Record<string, "error" | "off"> = {};

/**
 * Diagnostics of the Effect plugin that the repository declines, each with its reason, so that every other rule stays
 * at `error`. The upstream preset marks `preferEffectString` a `warn` ("with semantic caveats"); `@effect/tsgo` 0.63.0
 * made it fire on 413 native string calls. Effect's `String` is data-last only (`Str.startsWith("x")(s)`), and
 * `indexOf`, `lastIndexOf`, `match`, `search` and `codePointAt` return an `Option` and `split` a `NonEmptyArray`, so a
 * part of the sites changes behaviour and needs a decision per site. Spec 0024 records the open decision.
 */
export const declined = {
  preferEffectString: true,
} as const satisfies Record<string, true>;

for (const preset of [strict, effectNative]) {
  for (const rule of Object.getOwnPropertyNames(preset.rules ?? {})) {
    lint[rule] = "error";
  }
}

for (const name of Object.getOwnPropertyNames(defaults)) {
  if (!hasKey(defaults, name)) {
    continue;
  }

  const kebab = name
    .replaceAll(/(?<left>[A-Z]+)(?<right>[A-Z][a-z])/gu, "$<left>-$<right>")
    .replaceAll(/(?<left>[a-z0-9])(?<right>[A-Z])/gu, "$<left>-$<right>")
    .toLowerCase();

  const rule = `effecttsgo/${kebab}`;

  if (name in declined) {
    lint[rule] = "off";
    editor[name] = "off";
  } else if (defaults[name].default !== "off" || rule in lint) {
    lint[rule] = "error";
    editor[name] = "error";
  }
}

export const diagnosticRules = { editor, lint };
