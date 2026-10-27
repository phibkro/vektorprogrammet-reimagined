// Chart labels for the membership-write model, in the words of its reader: an engineer who reviews a change to
// MembershipRepository or to the Teams commands. The pstack /statechart skill loads this file as the mapping of any
// root module (Race, WhatIf, Pair, Story). It is plain JavaScript on purpose: /statechart loads it from a scratch
// folder outside the repository, where Effect does not resolve.
//
// Every command is named A, B, C in the order of the model's transactions. A state reads "what the commands do:
// where each of them is", so the commands (which never change on a path) form the context and the progress changes.
export const readerActions = [];

const NAMES = ["A", "B", "C"];
const who = (t) => NAMES[Number(t.slice(1)) - 1];
const sem = (n) => `semester ${n}`;
const NOBODY = "NoTxn";

function command(plan) {
  switch (plan.kind) {
    case "addMember": {
      const span =
        plan.s === plan.e ? sem(plan.s) : `${sem(plan.s)} to ${plan.e}`;

      return `adds the person to team ${plan.team} for ${span}`;
    }
    case "extend": {
      return `extends a membership to semester ${plan.e}`;
    }
    case "endEarly": {
      return `ends a membership from semester ${plan.from}`;
    }
    case "change": {
      return `moves a membership to team ${plan.team2} from semester ${plan.from}`;
    }
    case "cancel": {
      return "cancels a planned membership";
    }
    case "replace": {
      return "cancels a planned membership and adds another in its place";
    }
    case "lockBoth": {
      return `locks person ${plan.person}, then person ${plan.person2}`;
    }
    default: {
      return plan.kind;
    }
  }
}

const txns = (v) => Object.keys(v.plan).sort();

const context = (v) =>
  txns(v)
    .map((t) => `${who(t)} ${command(v.plan[t])}`)
    .join("; ");

const answers = {
  AlreadyExists: 'is told "already exists"',
  Conflict: 'is told "it changed"',
  NotFound: 'is told "not found"',
  cancelled: "is cancelled and rolls back",
  defect: "gets an error (500)",
};

function phase(v, t) {
  if (v.status[t] === "committed") {
    return "committed";
  }
  if (v.status[t] === "aborted") {
    const answer = answers[v.outcome[t]] ?? v.outcome[t];

    return v.err[t] === "40P01"
      ? `is rolled back as a deadlock victim and ${answer}`
      : answer;
  }
  const waitsFor = v.blocked[t];
  const awaitedEnded = waitsFor !== NOBODY && v.status[waitsFor] !== "running";
  if (awaitedEnded) {
    return v.pending[t].length > 0
      ? `wrote its row, and ${who(waitsFor)} has finished, so its overlap check looks again`
      : `${who(waitsFor)} has finished, so it carries on`;
  }
  if (v.pending[t].length > 0) {
    return waitsFor === NOBODY
      ? "wrote its row, overlap check still to do"
      : `wrote its row, its overlap check waits for ${who(waitsFor)}`;
  }
  if (waitsFor !== NOBODY) {
    return v.holder.includes(waitsFor)
      ? `waits for ${who(waitsFor)}'s person lock`
      : `waits for ${who(waitsFor)}'s change of the row`;
  }
  if (v.holder.includes(t)) {
    return "holds the person lock";
  }
  return v.pc[t] === 1 ? "not started" : "running";
}

export function state(v) {
  const progress = txns(v)
    .map((t) => `${who(t)} ${phase(v, t)}`)
    .join(", ");

  return `${context(v)}: ${progress}`;
}

// The command whose step this is: the one that moved.
const mover = (before, after) =>
  txns(before).find(
    (t) =>
      before.pc[t] !== after.pc[t] ||
      before.status[t] !== after.status[t] ||
      before.blocked[t] !== after.blocked[t] ||
      before.pending[t].length !== after.pending[t].length ||
      before.holder.includes(t) !== after.holder.includes(t)
  );

// The commands that wait for each other in a cycle through `t`.
function cycle(before, t) {
  const members = [t];
  let next = before.blocked[t];
  while (next !== NOBODY && next !== t && members.length <= NAMES.length) {
    members.push(next);
    next = before.blocked[next];
  }

  return members;
}

const LABELS = {
  CheckPass: (t) => `${who(t)}'s overlap check finds nothing that overlaps`,
  CheckRefuse: (t) =>
    `${who(t)}'s overlap check meets a committed membership: "already exists"`,
  CheckWait: (t, before, after) =>
    `${who(t)}'s overlap check meets ${who(after.blocked[t])}'s unfinished row and waits for ${who(after.blocked[t])}`,
  Commit: (t) => `${who(t)} commits`,
  Cancel: (t) =>
    `${who(t)}'s request is cancelled and its transaction rolls back`,
  Deadlock: (t, before) =>
    `PostgreSQL finds that ${cycle(before, t).map(who).join(" and ")} wait for each other and rolls ${who(t)} back (deadlock detected, 40P01)`,
  DeleteRow: (t, before, after) => {
    if (after.blocked[t] !== NOBODY) {
      return `${who(t)} deletes the membership and has to wait for ${who(after.blocked[t])}'s change`;
    }

    return after.status[t] === "aborted"
      ? `${who(t)}'s delete finds the membership changed: it is told so`
      : `${who(t)} deletes the planned membership`;
  },
  Finished: () => "",
  InsertRow: (t) =>
    `${who(t)} writes the new membership (its row and its index entry)`,
  LockPerson: (t, before, after) =>
    after.blocked[t] === NOBODY
      ? `${who(t)} takes the person's row lock`
      : `${who(t)} asks for the person's row lock and has to wait for ${who(after.blocked[t])}`,
  ReadRow: (t) => `${who(t)} reads the membership`,
  UpdateEnd: (t, before, after) => {
    if (after.blocked[t] !== NOBODY) {
      return `${who(t)} updates the membership and has to wait for ${who(after.blocked[t])}'s change`;
    }

    return after.status[t] === "aborted"
      ? `${who(t)}'s update finds the membership changed: it is told so`
      : `${who(t)} updates the membership's end`;
  },
  Wake: (t, before) =>
    `${who(before.blocked[t])} has finished: ${who(t)} carries on`,
};

export function step(action, before, after) {
  const t = mover(before, after);
  const label = LABELS[action];

  return label === undefined || t === undefined
    ? action
    : label(t, before, after);
}

export function cause(v, facts, invariant) {
  switch (invariant) {
    case "NoDeadlockAbort": {
      return "each of two writes waits for the other to finish, so PostgreSQL has to roll one of them back";
    }
    case "RefusalsAreTrue": {
      return 'a write is told "already exists" although no committed membership overlaps what it wrote';
    }
    case "NoOverlapCommitted": {
      return "two memberships of one person in one team that overlap are both committed";
    }
    case "LegalAtApply": {
      return "a change commits that was not allowed from the membership as it was when the change was applied";
    }
    default: {
      return null;
    }
  }
}
