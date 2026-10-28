/**
 * A scratch file that a quality test writes into the working tree for the length of one `vp lint` run, to see what the
 * lint does with it (`test/support/lintProbes.ts`). Vitest runs the test files of this package in parallel, so another
 * test's scan of the source (the module graph, the store boundary, the domain's source tests) can run while a probe is
 * on disk. Every scan of the working tree skips a probe through this one predicate, and a test that lints a directory
 * lints a list of files that it took through the same scan, so a probe is seen by the lint that wrote it and by nothing
 * else (spec 0020, review round 1: the F8 race).
 *
 * A probe's file name contains `Probe` after the name of the test that owns it (`storeBoundaryProbe.ts`,
 * `moduleGraphProbeCycleA.ts`).
 */
const probeName = /(?:storeBoundary|moduleGraph)Probe/u;

export const isProbe = (path: string): boolean => probeName.test(path);
