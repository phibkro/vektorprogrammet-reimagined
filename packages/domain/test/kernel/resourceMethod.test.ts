/**
 * Spec 0007c (ADR 0010): every command names its resource and method. The types refuse a command without them
 * (falsifier 1); the real declarations are complete (falsifier 2); and each check of the completeness test has a
 * negative control, one change to the sample domain that makes exactly that check report (falsifier 3).
 */
import { assert, describe, it } from "@effect/vitest";
import { Array as Arr, Option, Schema } from "effect";
import { Rpc } from "effect/rpc";
import { expectTypeOf } from "vite-plus/test";

import { Commands, Declarations, Domain, EntityName } from "../../src/index.ts";
import type { Declaration } from "../../src/kernel/domain.ts";
import { Sample } from "./sample.ts";

type Fields = Parameters<typeof Commands.info>[0];

describe("spec 0007c falsifier 1: the types refuse a command without its resource and method", () => {
  it("resource and method are required fields of info", () => {
    expectTypeOf<{ readonly summary: string }>().not.toExtend<Fields>();

    expectTypeOf<{
      readonly summary: string;
      readonly resource: Commands.Resource;
    }>().not.toExtend<Fields>();

    expectTypeOf<{
      readonly summary: string;
      readonly method: Commands.Method;
    }>().not.toExtend<Fields>();

    expectTypeOf<{
      readonly summary: string;
      readonly resource: Commands.Resource;
      readonly method: Commands.Method;
    }>().toExtend<Fields>();
  });

  it("a resource is one of a closed set, and a method is a standard one or a colon verb", () => {
    expectTypeOf<Fields["resource"]>().toEqualTypeOf<Commands.Resource>();
    expectTypeOf<"Membership">().toExtend<Fields["resource"]>();
    expectTypeOf<"Expense">().not.toExtend<Fields["resource"]>();
    expectTypeOf<"memberships">().not.toExtend<Fields["resource"]>();
    expectTypeOf<Fields["method"]>().toEqualTypeOf<Commands.Method>();
    expectTypeOf<"update">().toExtend<Fields["method"]>();
    expectTypeOf<":extend">().toExtend<Fields["method"]>();
    expectTypeOf<"patch">().not.toExtend<Fields["method"]>();
    expectTypeOf<"extend">().not.toExtend<Fields["method"]>();
  });

  it("the set of resources is the entities and the nouns that no audit row names, and the two lists share no noun", () => {
    assert.deepStrictEqual(
      Commands.Resources,
      [...EntityName.literals, ...Commands.NonEntityResources],
      "the closed set is built from both lists, so a noun has one home"
    );

    assert.deepStrictEqual(
      Arr.intersection(EntityName.literals, Commands.NonEntityResources),
      [],
      "a noun that an audit row names is an entity, and is not declared a second time"
    );
  });

  it("the verb of a method is the method itself, or the custom verb without its colon; get and list are the queries", () => {
    assert.deepStrictEqual(
      Arr.map(
        ["get", "list", "create", "update", "delete", ":extend"] as const,
        Commands.verbOf
      ),
      ["get", "list", "create", "update", "delete", "extend"]
    );

    assert.deepStrictEqual(Arr.map(Commands.StandardMethods, Commands.kindOf), [
      "query",
      "query",
      "command",
      "command",
      "command",
    ]);

    assert.strictEqual(Commands.kindOf(":extend"), "command");
  });
});

describe("spec 0007c falsifier 2: the declarations of every domain are complete", () => {
  it("every command of every domain has a resource and a method that its name, kind and transitions agree with, and no pair or tag repeats", () => {
    assert.deepStrictEqual(Domain.allProblems(Declarations), []);
  });

  it("the sample is complete before each negative control changes it", () => {
    assert.deepStrictEqual(Domain.allProblems([Sample]), []);
  });
});

/** The sample with the command `tag` declared again as `Rpc.make(…).annotate(Info, { …its Info, ...change })`. */
const redeclared = (
  tag: string,
  change: Partial<Commands.CommandInfo>
): Declaration => ({
  ...Sample,
  commands: Arr.map(Sample.commands, (rpc) =>
    Option.match(Commands.infoOf(rpc), {
      onNone: () => rpc,
      onSome: (info) =>
        rpc._tag === tag
          ? Rpc.make(tag, { success: Schema.Void }).annotate(Commands.Info, {
              ...info,
              ...change,
            })
          : rpc,
    })
  ),
});

describe("spec 0007c falsifier 3: each check has a negative control", () => {
  it("a custom verb that is not lowerCamelCase is reported", () => {
    assert.include(
      Domain.problems(redeclared("publishArticle", { method: ":Publish now" })),
      "publishArticle has the method :Publish now, which is neither a standard method nor a colon and a lowerCamelCase verb"
    );
  });

  it("a standard method whose name is not its verb and resource is reported: editTeam is not an update of a Team", () => {
    assert.include(
      Domain.problems(redeclared("createArticle", { resource: "Team" })),
      "createArticle is declared create on Team, so its name must be createTeam"
    );

    assert.include(
      Domain.problems(redeclared("createArticle", { method: "update" })),
      "createArticle is declared update on Article, so its name must be updateArticle"
    );
  });

  it("a custom method whose name does not start with its verb is reported", () => {
    assert.include(
      Domain.problems(redeclared("publishArticle", { method: ":release" })),
      "publishArticle is declared :release on Article, so its name must start with release"
    );
  });

  it("a list whose name does not start with list is reported", () => {
    assert.include(
      Domain.problems(redeclared("sweepArticle", { method: "list" })),
      "sweepArticle is declared list on Article, so its name must start with list"
    );
  });

  it("a get or a list on a command that applies a machine, is a job's or a credential's is reported: a query changes nothing", () => {
    assert.include(
      Domain.problems(redeclared("publishArticle", { method: "list" })),
      "publishArticle is declared list, a query, but it applies a machine's transition, and a query changes nothing"
    );

    assert.include(
      Domain.problems(redeclared("sweepArticle", { method: "list" })),
      "sweepArticle is declared list, a query, but it is the semesters job's command, and a query changes nothing"
    );

    assert.include(
      Domain.problems(
        redeclared("publishArticle", {
          credential: "activation",
          method: "get",
        })
      ),
      "publishArticle is declared get, a query, but it is the command of the activation credential, and a query changes nothing"
    );
  });

  it("a create with a transition from a state is reported", () => {
    assert.include(
      Domain.problems(redeclared("publishArticle", { method: "create" })),
      "publishArticle is declared create, but its transition from Draft to Published breaks the rule that a create starts from [*]"
    );
  });

  it("a delete that ends in a state is reported", () => {
    assert.include(
      Domain.problems(redeclared("createArticle", { method: "delete" })),
      "createArticle is declared delete, but its transition from [*] to Draft breaks the rule that a delete ends in [*]"
    );
  });

  it("an update that changes a state is reported", () => {
    assert.include(
      Domain.problems(redeclared("publishArticle", { method: "update" })),
      "publishArticle is declared update, but its transition from Draft to Published breaks the rule that an update changes no state"
    );
  });

  it("two commands with one resource and one method are reported, in one domain or two", () => {
    assert.include(
      Domain.allProblems([redeclared("publishArticle", { method: "create" })]),
      "createArticle and publishArticle are all declared create on Article"
    );

    assert.include(
      Domain.allProblems([Sample, { ...Sample, name: "notes again" }]),
      "createArticle is declared by notes and notes again"
    );
  });
});
