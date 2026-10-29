/**
 * Spec 0022 R1 and F2: the kernel knows a credential by its name and the one command it opens (`Subject.holder`), and the
 * service that issues credentials builds the subject (`codeHolder` in `accounts/code.ts`). The kernel compares: a holder
 * holds only for a principal narrowed to its own command and person, and `Domain.problems` refuses a credential command
 * that is granted to anything but the holder of that credential, or to a holder of another command.
 */
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import {
  Commands,
  CodePurpose,
  Domain,
  DomainErrorSchema,
  Grant,
  PersonId,
  Principal,
  Subject,
  codeHolder,
  codePolicy,
} from "../../src/index.ts";

const openDoor = Rpc.make("openDoor", {
  error: DomainErrorSchema,
  success: Schema.Void,
}).annotate(
  Commands.Info,
  Commands.info({
    credential: "door",
    method: ":open",
    resource: "Article",
    summary: "Open the door with its code.",
  })
);

const doorOf = (grants: readonly Grant.Row<"openDoor">[]) =>
  Domain.make({
    commands: RpcGroup.make(openDoor),
    grants,
    name: "doors",
    reads: {},
    title: "Doors",
  });

const holderOfDoor = Subject.holder({ command: "openDoor", purpose: "door" });

const person = PersonId.make(7);

const narrowedTo = (command: string, personId: PersonId) =>
  Principal.narrow(Principal.cases.Person.make({ memberships: [], personId }), {
    command,
    resource: { personId },
  });

describe("spec 0022 F2: a credential is a name and a command, and the kernel only compares", () => {
  it("control: a door that grants its command to the holder of its credential is complete", () => {
    assert.deepStrictEqual(
      Domain.problems(
        doorOf([Grant.make([holderOfDoor], ["openDoor"], "own")])
      ),
      []
    );
  });

  it("a command that its credential does not name, a holder of another purpose and a person's grant are each reported", () => {
    assert.include(
      Domain.problems(
        doorOf([
          Grant.make(
            [Subject.holder({ command: "closeDoor", purpose: "door" })],
            ["openDoor"],
            "own"
          ),
        ])
      ),
      "door is not the credential for openDoor"
    );

    assert.include(
      Domain.problems(
        doorOf([
          Grant.make(
            [Subject.holder({ command: "openDoor", purpose: "window" })],
            ["openDoor"],
            "own"
          ),
        ])
      ),
      "openDoor is not granted to Holder(window)"
    );

    assert.include(
      Domain.problems(
        doorOf([Grant.make([Subject.leader], ["openDoor"], "department")])
      ),
      "openDoor is not granted to Leader(d)"
    );
  });

  it("a holder holds for a principal narrowed to its command and person, and for no other", () => {
    const resource = { personId: person };

    assert.isTrue(
      Subject.holds(
        holderOfDoor,
        "own",
        narrowedTo("openDoor", person),
        resource
      )
    );

    assert.isFalse(
      Subject.holds(
        holderOfDoor,
        "own",
        narrowedTo("closeDoor", person),
        resource
      ),
      "a narrowing to another command does not open this one"
    );

    assert.isFalse(
      Subject.holds(
        holderOfDoor,
        "own",
        narrowedTo("openDoor", PersonId.make(8)),
        resource
      ),
      "a narrowing to another person does not open this person's record"
    );

    assert.isFalse(
      Subject.holds(
        holderOfDoor,
        "own",
        Principal.cases.Person.make({ memberships: [], personId: person }),
        resource
      ),
      "a person without a code holds nothing as its holder"
    );
  });

  it("the codes' subject is the kernel's holder of the purpose and the command that the policy names", () => {
    for (const purpose of CodePurpose.literals) {
      assert.deepStrictEqual(
        codeHolder(purpose),
        Subject.holder({ command: codePolicy[purpose].command, purpose })
      );
    }
  });
});
