import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Array as Arr, Effect, FileSystem, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { parseSync } from "oxc-parser";

const common = {
  id: Schema.NonEmptyString,
  nativeAlternativesExamined: Schema.NonEmptyArray(Schema.NonEmptyString),
  owner: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
  retirementTrigger: Schema.NonEmptyString,
};

const Exception = Schema.Struct({
  ...common,
  scope: Schema.Struct({
    directives: Schema.NonEmptyArray(Schema.NonEmptyString),
    files: Schema.NonEmptyArray(Schema.NonEmptyString),
  }),
  versions: Schema.Record(Schema.NonEmptyString, Schema.NonEmptyString),
});

const TypeBridge = Schema.Struct({
  ...common,
  scope: Schema.Struct({ files: Schema.NonEmptyArray(Schema.NonEmptyString) }),
  versions: Schema.Record(Schema.NonEmptyString, Schema.NonEmptyString),
});

const Registry = Schema.Struct({
  description: Schema.NonEmptyString,
  exceptions: Schema.Array(Exception),
  typeBridges: Schema.Array(TypeBridge),
});

const decodeRegistry = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Registry)
);

export class RegistryViolations extends Schema.TaggedError<
  RegistryViolations,
  { readonly brand: unique symbol }
>()("RegistryViolations", {
  message: Schema.String,
}) {}

const directivePattern =
  /(?:oxlint-disable(?:-next-line|-line)?|eslint-disable(?:-next-line|-line)?|@ts-expect-error|@ts-ignore|@ts-nocheck)/gu;

const sourcePattern = /\.[cm]?[jt]sx?$/u;

/** The registry sits next to this checker; the source paths inside it stay repo-relative. */
const registryPath = new URL("effect-exceptions.json", import.meta.url)
  .pathname;

interface Site {
  readonly directive: string;
  readonly line: number;
  readonly path: string;
}

const isScannable = (path: string): boolean =>
  sourcePattern.test(path) &&
  !path.startsWith("node_modules/") &&
  !path.startsWith(".devenv/");

const main = Effect.gen(function* main() {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const listing = yield* spawner.string(
    ChildProcess.make("git", ["ls-files", "-c", "-o", "--exclude-standard"])
  );

  const listed = Arr.filter(listing.split(/\r?\n/u), (path) => path !== "");

  // `git ls-files -c` also lists tracked files deleted from the working tree (for example mid-rename); only files present on disk are scanned.
  const paths = Arr.flatten(
    yield* Effect.forEach(listed, (path) =>
      Effect.map(fs.exists(path), (exists): readonly string[] =>
        exists ? [path] : []
      )
    )
  );

  const registry = yield* decodeRegistry(
    yield* fs.readFileString(registryPath)
  );

  const sitesPerFile = yield* Effect.forEach(
    Arr.filter(paths, isScannable),
    (path) =>
      Effect.map(fs.readFileString(path), (text): readonly Site[] => {
        const { comments } = parseSync(path, text);

        return Arr.flatMap(comments, (comment) => {
          const line = text.slice(0, comment.start).split("\n").length;

          return Arr.map(
            [...comment.value.matchAll(directivePattern)],
            ([directive]): Site => ({ directive, line, path })
          );
        });
      })
  );

  const sites = Arr.flatten(sitesPerFile);

  const classified = Arr.map(sites, (site) => ({
    exception: Arr.findFirst(
      registry.exceptions,
      (entry) =>
        entry.scope.files.includes(site.path) &&
        entry.scope.directives.includes(site.directive)
    ),
    site,
  }));

  const unregistered = Arr.flatMap(classified, ({ exception, site }) =>
    Option.isNone(exception)
      ? [`${site.path}:${site.line}: unregistered ${site.directive}`]
      : []
  );

  const liveIds = new Set(
    Arr.flatMap(classified, ({ exception }) =>
      Option.isSome(exception) ? [exception.value.id] : []
    )
  );

  const exceptionFindings = Arr.flatMap(registry.exceptions, (exception) => [
    ...(Arr.some(paths, (path) => exception.scope.files.includes(path))
      ? []
      : [`${registryPath}: ${exception.id} lists no existing source file`]),
    ...(liveIds.has(exception.id)
      ? []
      : [`${registryPath}: ${exception.id} has no live suppression site`]),
  ]);

  const exceptionIds = Arr.map(registry.exceptions, (entry) => entry.id);
  const bridgeIds = Arr.map(registry.typeBridges, (entry) => entry.id);

  const exceptionDuplicates = Arr.flatMap(exceptionIds, (id, index) =>
    Arr.contains(Arr.take(exceptionIds, index), id)
      ? [`${registryPath}: duplicate id ${id}`]
      : []
  );

  const bridgeFindings = Arr.flatMap(registry.typeBridges, (bridge, index) => [
    ...(Arr.some(paths, (path) => bridge.scope.files.includes(path))
      ? []
      : [`${registryPath}: ${bridge.id} lists no existing type-bridge file`]),
    ...(Arr.contains(
      [...exceptionIds, ...Arr.take(bridgeIds, index)],
      bridge.id
    )
      ? [`${registryPath}: duplicate id ${bridge.id}`]
      : []),
  ]);

  const findings = [
    ...unregistered,
    ...exceptionFindings,
    ...exceptionDuplicates,
    ...bridgeFindings,
  ];

  if (Arr.isReadonlyArrayNonEmpty(findings)) {
    const report = Arr.join(findings, "\n");

    yield* Effect.logError(report);

    return yield* new RegistryViolations({ message: report });
  }

  return yield* Effect.log(
    `Effect registry clean (${registry.exceptions.length} suppression exceptions, ${registry.typeBridges.length} type bridges).`
  );
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)), {
  disableErrorReporting: true,
});
