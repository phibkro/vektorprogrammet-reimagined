import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Array as Arr, Effect, FileSystem, Schema } from "effect";

import { diagnosticRules } from "./diagnosticRules.ts";
import { unstablePolicy } from "./unstablePolicy.ts";

const JsonMap = Schema.Record(Schema.String, Schema.Json);

const Plugin = Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [
  JsonMap,
]);

const Options = Schema.StructWithRest(
  Schema.Struct({ plugins: Schema.Array(Plugin) }),
  [JsonMap]
);

const Config = Schema.StructWithRest(
  Schema.Struct({ compilerOptions: Options }),
  [JsonMap]
);

const ConfigFile = Schema.fromJsonString(Config, { space: 2 });
const decode = Schema.decodeEffect(ConfigFile);
const decodeConfig = Schema.decodeUnknownEffect(Config);
const encode = Schema.encodeEffect(ConfigFile);

const main = Effect.gen(function* syncEffectPolicy() {
  const fs = yield* FileSystem.FileSystem;

  const config = yield* decode(yield* fs.readFileString("tsconfig.json"));

  const plugins = Arr.map(config.compilerOptions.plugins, (plugin) =>
    plugin.name === "@effect/language-service"
      ? {
          ...plugin,
          ...unstablePolicy,
          diagnosticSeverity: diagnosticRules.editor,
        }
      : plugin
  );

  const result = yield* decodeConfig({
    ...config,
    compilerOptions: { ...config.compilerOptions, plugins },
  });

  yield* fs.writeFileString("tsconfig.json", `${yield* encode(result)}\n`);
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
