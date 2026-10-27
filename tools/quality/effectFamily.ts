import { Array as Arr, Order, Result } from "effect";

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
  Arr.filterMap(Arr.fromIterable(lock.matchAll(entry)), ({ groups }) =>
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
