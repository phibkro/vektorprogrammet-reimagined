/**
 * A small domain declared with the kernel's own constructs, so the kernel's laws are tested without a real domain
 * in the way: three commands (one a job's), one read, one machine, and a grant row of every kind.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import {
  Commands,
  DepartmentId,
  Domain,
  DomainErrorSchema,
  Grant,
  Machine,
  PersonId,
  Subject,
} from "../../src/index.ts";

export const create = Rpc.make("create", {
  error: DomainErrorSchema,
  payload: { departmentId: DepartmentId },
  success: Schema.Void,
}).annotate(Commands.Info, Commands.info({ summary: "Create a note." }));

export const publish = Rpc.make("publish", {
  error: DomainErrorSchema,
  payload: { departmentId: DepartmentId, personId: PersonId },
  success: Schema.String,
}).annotate(
  Commands.Info,
  Commands.info({
    machine: "Note",
    replaces: ["RULE-001"],
    summary: "Publish a note.",
  })
);

export const sweep = Rpc.make("sweep", {
  error: DomainErrorSchema,
  success: Schema.Finite,
}).annotate(
  Commands.Info,
  Commands.info({ job: "semesters", summary: "Archive old notes." })
);

export const Notes = RpcGroup.make(create, publish, sweep);

export const NoteStates = Schema.TaggedUnion({ Draft: {}, Published: {} });

/** The guard reads what the caller supplies: how many words the note has. */
export const NoteMachine = Machine.make({
  commands: Notes,
  name: "Note",
  states: NoteStates,
  transitions: [
    { command: "create", from: [Machine.Boundary], to: "Draft" },
    {
      command: "publish",
      from: ["Draft"],
      guard: ({ words }: { readonly words: number }) => words > 0,
      to: "Published",
      when: "the note has words",
    },
  ],
});

export const Sample = Domain.make({
  commands: Notes,
  grants: [
    Grant.make([Subject.leader, Subject.board], ["create"], "department"),
    Grant.make([Subject.self], ["publish"], "own"),
    Grant.make([Subject.leader], ["publish"], "department"),
    Grant.make([Subject.member], ["viewNotes"], "department"),
    Grant.make([Subject.system("semesters")], ["sweep"], "all"),
  ],
  machines: [NoteMachine],
  name: "notes",
  reads: {
    viewNotes: { replaces: [], summary: "See the notes of the department." },
  },
  title: "Notes",
});
