/**
 * Spec 0022 F1: the kernel is generic. A file of `packages/domain/src/kernel/` imports files of `kernel/` and `shared/`
 * (the libraries' own directory) and external packages, and no service directory. The module graph cannot see this for
 * `organisation/semester.ts`, which is vocabulary and so legal for a library to import, and for a code or a semester
 * that is imported again from a directory that is not a module of its own; this reads the directory itself.
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Effect } from "effect";

import type { SourceFile } from "../resolveImports.ts";
import { d, parsed } from "./support/moduleGraphFixture.ts";
import { realTree } from "./support/realTree.ts";

const kernel = `${d}/kernel/`;

const allowed = [kernel, `${d}/shared/`];

/** The imports of kernel files that reach a directory other than `kernel/` and `shared/`, as `file:line: target`. */
const kernelLeaks = (files: readonly SourceFile[]): readonly string[] =>
  Arr.flatMap(
    Arr.filter(files, (file) => file.path.startsWith(kernel)),
    (file: SourceFile) =>
      Arr.flatMap(file.imports, ({ line, target }) =>
        target.kind === "file" &&
        !Arr.some(allowed, (directory) => target.path.startsWith(directory))
          ? [`${file.path}:${line}: ${target.path}`]
          : []
      )
  );

describe("spec 0022 F1: the kernel is generic", () => {
  it("control: a kernel file that imports a credential or a semester is reported, and one that imports shared is not", () => {
    assert.deepStrictEqual(
      kernelLeaks([
        parsed(
          `${d}/kernel/subject.ts`,
          'import { codePolicy } from "../accounts/code.ts";\nimport { Semester } from "../organisation/semester.ts";\nimport { PersonId } from "../shared/ids.ts";\nimport { Principal } from "./principal.ts";\nimport { Schema } from "effect";'
        ),
        parsed(
          `${d}/teams/declaration.ts`,
          'import { Semester } from "../organisation/semester.ts";'
        ),
      ]),
      [
        `${d}/kernel/subject.ts:1: ${d}/accounts/code.ts`,
        `${d}/kernel/subject.ts:2: ${d}/organisation/semester.ts`,
      ]
    );
  });

  it.effect("the real kernel imports only kernel and shared files", () =>
    Effect.gen(function* realKernel() {
      const files = yield* realTree;

      assert.isAbove(
        Arr.filter(files, (file) => file.path.startsWith(kernel)).length,
        5
      );
      assert.deepStrictEqual(kernelLeaks(files), []);
    })
  );
});
