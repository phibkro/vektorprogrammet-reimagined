/**
 * A small domain declared with the kernel's own constructs, so the kernel's laws are tested without a real domain
 * in the way: three commands (one a job's), one read, one machine, and a grant row of every kind. Its resource is
 * `Article`: a note is an article that has not been published.
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

export const createArticle = Rpc.make("createArticle", {
  error: DomainErrorSchema,
  payload: { departmentId: DepartmentId },
  success: Schema.Void,
}).annotate(
  Commands.Info,
  Commands.info({
    machine: "Note",
    method: "create",
    resource: "Article",
    summary: "Create a note.",
  })
);

export const publishArticle = Rpc.make("publishArticle", {
  error: DomainErrorSchema,
  payload: { departmentId: DepartmentId, personId: PersonId },
  success: Schema.String,
}).annotate(
  Commands.Info,
  Commands.info({
    machine: "Note",
    method: ":publish",
    replaces: ["RULE-001"],
    resource: "Article",
    summary: "Publish a note.",
  })
);

export const sweepArticle = Rpc.make("sweepArticle", {
  error: DomainErrorSchema,
  success: Schema.Finite,
}).annotate(
  Commands.Info,
  Commands.info({
    job: "semesters",
    method: ":sweep",
    resource: "Article",
    summary: "Archive old notes.",
  })
);

export const Notes = RpcGroup.make(createArticle, publishArticle, sweepArticle);

export const NoteStates = Schema.TaggedUnion({ Draft: {}, Published: {} });

const NoteContext = Schema.Struct({ words: Schema.Finite });

/** The guard reads what the caller supplies: how many words the note has. */
export const NoteMachine = Machine.make({
  commands: Notes,
  context: NoteContext,
  name: "Note",
  states: NoteStates,
  transitions: [
    { command: "createArticle", from: [Machine.Boundary], to: "Draft" },
    {
      command: "publishArticle",
      from: ["Draft"],
      guard: Schema.makeFilter(
        ({ words }: typeof NoteContext.Type) => words > 0,
        { representation: { id: "test/note/hasWords", payload: null } }
      ),
      to: "Published",
      when: "the note has words",
    },
  ],
});

export const Sample = Domain.make({
  commands: Notes,
  grants: [
    Grant.make(
      [Subject.leader, Subject.board],
      ["createArticle"],
      "department"
    ),
    Grant.make([Subject.self], ["publishArticle"], "own"),
    Grant.make([Subject.leader], ["publishArticle"], "department"),
    Grant.make([Subject.member], ["viewNotes"], "department"),
    Grant.make([Subject.system("semesters")], ["sweepArticle"], "all"),
  ],
  machines: [NoteMachine],
  name: "notes",
  reads: {
    viewNotes: { replaces: [], summary: "See the notes of the department." },
  },
  title: "Notes",
});
