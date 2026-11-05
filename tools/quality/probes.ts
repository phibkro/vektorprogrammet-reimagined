import { Record as Rec } from "effect";

/**
 * The scratch files that the quality tests write into the working tree for the length of one `vp lint` run, to see what
 * the lint does with them (`test/support/lintProbes.ts`). Vitest runs the test files of this package in parallel, so
 * another test's scan of the source (the module graph, the store boundary, the domain's source tests) can run while a
 * probe is on disk. Every scan of the working tree skips these exact paths (`workingTreePaths`), and the tests take the
 * paths from here, so a probe is seen by the lint that wrote it and by nothing else (spec 0020, review rounds 1 and 2).
 *
 * The paths are exact and not a name pattern: a committed file whose name only resembles a probe's is read like any other.
 */
export const storeBoundaryProbes = {
  adapterTest: "apps/web/test/storeBoundaryProbe.postgres.test.ts",
  clean: "apps/web/src/server/storeBoundaryProbeClean.ts",
  domainSibling: "apps/web/src/domain/storeBoundaryProbe.ts",
  harness: "tools/db-path-spike/storeBoundaryProbe.ts",
  restricted: "apps/web/src/server/storeBoundaryProbe.ts",
} as const;

export const moduleGraphProbes = {
  cycleA: "apps/web/src/adapters/db/moduleGraphProbeCycleA.ts",
  cycleB: "apps/web/src/adapters/db/moduleGraphProbeCycleB.ts",
  flatA: "apps/web/src/adapters/db/moduleGraphProbeFlatA.ts",
  flatB: "apps/web/src/adapters/db/moduleGraphProbeFlatB.ts",
} as const;

const probePaths: ReadonlySet<string> = new Set([
  ...Rec.values(storeBoundaryProbes),
  ...Rec.values(moduleGraphProbes),
]);

export const isProbe = (path: string): boolean => probePaths.has(path);
