/**
 * Spec 0007c: a machine is asked about the commands of its own group. `command` is inferred from the table alone, so a
 * name that the group does not have is a type error. Before this, the parameter took any string beside the table's
 * tags, and the rename of ten commands left ten test strings that compiled and asked a machine about a command that it
 * never had. The statement that must not type-check is under a `@ts-expect-error` that fails the type check itself the
 * day it starts to compile; it never runs.
 */
import { assert, describe, it } from "@effect/vitest";

import { Machine } from "../../src/index.ts";
import { NoteMachine } from "./sample.ts";

const words = { words: 4 };

const publishes = () =>
  Machine.can(NoteMachine, "publishArticle", "Draft", words);

const startsFromBoundary = () =>
  Machine.startsFrom(NoteMachine, "createArticle", Machine.Boundary);

const staleName = () =>
  // @ts-expect-error `publish` was the note's command before the names followed their method; the group has no such command
  Machine.can(NoteMachine, "publish", "Draft", words);

const staleStartsFrom = () =>
  // @ts-expect-error the same holds for the controls a page offers
  Machine.startsFrom(NoteMachine, "create", Machine.Boundary);

describe("spec 0007c: a machine query names a command of its group", () => {
  it("a command of the group is accepted", () => {
    assert.isTrue(publishes());
    assert.isTrue(startsFromBoundary());
  });

  it("a name that the group does not have does not type-check, and the machine allows nothing under it", () => {
    assert.isFunction(staleName);
    assert.isFunction(staleStartsFrom);
    assert.isFalse(staleName());
    assert.isFalse(staleStartsFrom());
  });
});
