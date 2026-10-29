import { Array as Arr, Order, Result, String as Str } from "effect";

interface Locked {
  readonly name: string;
  readonly version: string;
}

// A `bun.lock` entry is `"<key>": ["<name>@<version>", ...]`. The key can be a nested path, the name cannot.
const entry =
  /^\s+"[^"]+": \["(?<name>effect|@effect\/[^@"]+)@(?<version>[^"]+)"/gmu;

// `@effect/tsgo` and its platform binaries are a separate release line.
const ownLine = /^@effect\/tsgo(?:-|$)/u;

const locked = (lock: string): readonly Locked[] =>
  Arr.filterMap(Arr.fromIterable(Str.matchAll(entry)(lock)), ({ groups }) =>
    groups?.name === undefined || groups.version === undefined
      ? Result.failVoid
      : Result.succeed({ name: groups.name, version: groups.version })
  );

/**
 * Sentences that describe how the `@effect/*` family in a `bun.lock` text steps out of line with `effect`.
 * Empty when `effect` has one locked version and every family package is that version.
 */
export const effectFamilyDrift = (lock: string): readonly string[] => {
  const entries = locked(lock);

  const versions = Arr.sort(
    Arr.dedupe(
      Arr.map(
        Arr.filter(entries, ({ name }) => name === "effect"),
        ({ version }) => version
      )
    ),
    Order.String
  );

  const [effect, ...others] = versions;

  if (effect === undefined || others.length > 0) {
    return [
      `effect must have exactly one locked version, found: ${Arr.isArrayNonEmpty(versions) ? Arr.join(versions, ", ") : "none"}`,
    ];
  }

  return Arr.filterMap(entries, ({ name, version }) =>
    name === "effect" || ownLine.test(name) || version === effect
      ? Result.failVoid
      : Result.succeed(`${name} is locked at ${version}, effect at ${effect}`)
  );
};

/** A workspace file that pins `@effect/tsgo`, and the version it pins. */
export interface TsgoPin {
  readonly file: string;
  readonly version: string;
}

/**
 * Sentences that describe how the workspace pins of `@effect/tsgo` step out of line with the root's. The lint presets
 * (`@effect/tsgo/oxlint-presets`) and the diagnostic rules resolve from the nearest `node_modules`, so a package that
 * keeps its own pin feeds its own, older rules to its own lint run. Empty when every pin is the root's.
 */
export const tsgoPinDrift = (
  root: TsgoPin,
  pins: readonly TsgoPin[]
): readonly string[] =>
  Arr.filterMap(pins, ({ file, version }) =>
    version === root.version
      ? Result.failVoid
      : Result.succeed(
          `${file} pins @effect/tsgo ${version}, ${root.file} pins ${root.version}`
        )
  );
