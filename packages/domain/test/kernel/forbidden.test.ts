/**
 * Spec 0007c R2: a command that refuses on its own names a command of its own domain. `Forbidden.command` is a string,
 * as it is on the wire (the error sits below the declarations, and the kernel's tests declare domains of their own), so
 * the type is in the domain's `forbidden`: its parameter is the names of the domain's group and reads. R1 item 3's
 * defect, a renamed command left behind as a string that compiled, had reached the three hand-written refusals of
 * `createAdminGrant`, `deleteAdminGrant` and the code endpoints. A name that the domain does not have is a type error
 * now, and the code endpoints take theirs from `codePolicy`. The type tests need no suppression: `vp check` fails the
 * day an assertion stops holding.
 */
import { assert, describe, it } from "@effect/vitest";
import { expectTypeOf } from "vite-plus/test";

import { Forbidden, Teams } from "../../src/index.ts";
import type { CodePurpose, Accounts, codePolicy } from "../../src/index.ts";
import { Sample } from "./sample.ts";

type TeamsNames = Parameters<typeof Teams.TeamsDomain.forbidden>[0];

type AccountNames = Parameters<typeof Accounts.AccountDomain.forbidden>[0];

type SampleNames = Parameters<typeof Sample.forbidden>[0];

describe("spec 0007c R2: a refusal names a command of its domain", () => {
  it("the refusal of a domain takes the commands and reads of that domain, and no other string", () => {
    expectTypeOf<SampleNames>().toEqualTypeOf<
      "createArticle" | "publishArticle" | "sweepArticle" | "viewNotes"
    >();

    expectTypeOf<"createAdminGrant">().toExtend<TeamsNames>();
    expectTypeOf<"deleteAdminGrant">().toExtend<TeamsNames>();
    expectTypeOf<"viewTeams">().toExtend<TeamsNames>();
  });

  it("a misspelled, a renamed and a foreign name are refused by the types", () => {
    expectTypeOf<"createAdminGrnat">().not.toExtend<TeamsNames>();
    expectTypeOf<"grantAdmin">().not.toExtend<TeamsNames>();
    expectTypeOf<"revokeAdmin">().not.toExtend<TeamsNames>();
    expectTypeOf<"activateAccount">().not.toExtend<TeamsNames>();
    expectTypeOf<string>().not.toExtend<TeamsNames>();
  });

  it("the code endpoints refuse with the command of the code's purpose, and that is a command of the account domain", () => {
    expectTypeOf<
      (typeof codePolicy)[CodePurpose]["command"]
    >().toExtend<AccountNames>();

    expectTypeOf<"activate">().not.toExtend<AccountNames>();
  });

  it("a refusal is Forbidden and carries the name it was given", () => {
    const refusal = Teams.TeamsDomain.forbidden("createAdminGrant");

    assert.instanceOf(refusal, Forbidden);
    assert.strictEqual(refusal.command, "createAdminGrant");

    assert.strictEqual(Sample.forbidden("viewNotes").command, "viewNotes");
  });
});
