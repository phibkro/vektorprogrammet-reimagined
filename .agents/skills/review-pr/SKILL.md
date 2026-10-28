---
name: review-pr
description: The automated pull-request loop for this repository: independent reviewers verify a PR with the project's verification skills and keep those skills true, a fixer addresses findings, and a passing PR is merged. Use when a PR is ready for review, when asked to review or merge a PR, or when a review round finishes.
---

# Review and merge a pull request

The lead (the session that owns merges) runs this loop. Reviewers and fixers are separate agents, so the one who judges a change never wrote it.

```text
round 1..n:
  reviewers (independent, read-only on product code) → findings with severity
  pass?  → merge
  else   → fixer addresses every finding (incl. skill maintenance) → push → next round
stop:   after round 3, unless an open finding is critical or high (then keep going);
        a stop without a pass is reported to the operator, never merged
```

## 1. Prepare

- Create a separate detached worktree for each reviewer/fixer role: `git worktree add --detach ../reimagined-pr-$N-<role> origin/<head branch>` (no local branch); each worktree has its own devenv state. The `verify-vektorprogrammet` skill's `pr-$N` recipe is for a single reviewer, so do not share that worktree among parallel reviewers. If PostgreSQL fails to start in the worktree, follow the worktree gotcha in `AGENTS.md` (§ Run it).
- Read the PR body, its spec in `docs/specs/` (falsifiers and Revisions), and `git diff --stat origin/main...HEAD`.

## 2. Review round: two independent reviewers, in parallel

Give each reviewer the PR number, the worktree, the spec, and this section. Reviewers do not edit product code and do not push or comment; they report.

**Verification reviewer.**

1. Run `verify-vektorprogrammet` for every feature its path table maps to the changed paths, and keep the evidence (run directory, `REPORT.md`).
2. Run `verify-membership-writes` (`run.sh`, and `--code` when `packages/db` changed) when `run.sh --touched origin/main` prints `touched`.
3. **Keep the verification skills true.** For each changed behaviour, check that the feature map still describes it (entry points, selectors, expected end state), that the path table maps the changed paths, and that the TLA+ coverage block names every writer the model must know. A gap is a finding (`maintenance`); a skill that now describes behaviour the code no longer has is a finding of the severity of the behaviour it hides.

**Conformance reviewer.** The spec is written and built in one step and arrives with the code (a plan is not reviewed on its own), so this reviewer judges three things together:

1. **The plan:** the spec states the right problem, journey and falsifiers, and its Revisions explain each change made while building.
2. **The agreement:** the code does what the spec, with its Revisions, says. Undeclared scope, a falsifier with no test, or a silent change to the plan is a finding of medium or above.
3. Every falsifier of the spec is demonstrated by a test or run that can fail (a negative control exists and was shown), and the PR body's evidence matches what the branch contains.
4. The repository rules in `AGENTS.md`: one source per fact, no second role list, reads never write, race tests run many rounds, exceptions registered, Effect diagnostics clean.
5. Security and data: authorization on every new read and command, personal data declared, no secret or personal data in code, logs or fixtures.

Both read CI's result on the head (`gh pr checks <n>`), including the `Formal verification` job.

### Severity

| Severity | Meaning | Examples |
| --- | --- | --- |
| critical | data loss, a security hole, or a broken main once merged | an unguarded write, a migration that does not apply, a leaked secret |
| high | a spec falsifier is not met, or behaviour a user relies on is wrong | a 2xx where the grant says no; a race the model or a 300-round test catches |
| medium | a rule of `AGENTS.md` broken, a verification skill out of step, evidence that does not match the branch | a second list of a fact; a feature map missing a changed entry point |
| low | clarity or maintainability with no behavioural effect | a misleading name or comment |
| nit | taste | — |

Each finding: severity, file:line or run path, what is wrong in one sentence, and the evidence (command and output, or the counterexample in the code's words).

## 3. Decide

**Pass** when all of these hold: no open finding of medium or above; CI green on the head (including `Formal verification` when it ran); the verification evidence exists for every mapped feature. Low and nit findings go into the merge comment, or are fixed if cheap.

- **Merge a passing PR** with `.agents/skills/review-pr/merge.sh <n> "<type>: <summary>"` from the main checkout (squash, title `<type>: <summary> (#<n>)`). It refuses (exit 4) unless a round recorded by `record-round.sh` passed the PR's current head, waits for CI green on that head, and merges only that head (`--match-head-commit`). If `main` moved since the head was reviewed, it computes the expected tree with `git merge-tree --write-tree origin/main <reviewed head>` and refuses on conflicts (exit 2) or on files that both changed (exit 3): then rebase, require CI green on the rebased head, and record a new round on it. After a rebase without overlap, `git rev-parse HEAD^{tree}` must equal the expected tree.

**Otherwise**, start a fixer: a separate agent in the PR's worktree, with the findings verbatim. It fixes the code and, for `maintenance` findings, the verification skills themselves (feature maps, path table, TLA+ model and coverage block, sync commit only after confirming the model against the new code). It commits, pushes, and reports. Then the next round, with fresh reviewers.

## 4. Iteration limit

- Rounds 1 to 3: iterate until the PR passes.
- After round 3: continue only while an open finding is **critical or high**. If only medium or lower findings remain, stop: do not merge; report the PR, the open findings and the rounds to the operator.
- A finding that the same fix has failed twice is reported at once, whatever the round.

## 5. Record

Every round is recorded on the PR, so the review is visible where the change is (the repository is public) and outlives the agents' transcripts. The lead posts it with `.agents/skills/review-pr/record-round.sh <n> <round> <pass|changes> <body-file>`: a GitHub review (comment) headed by the marker `<!-- review-round n=<round> head=<sha> verdict=<pass|changes> -->`, with the head read from GitHub. The body holds the reviewers' findings with severity, what the fixer changed (commits) and the evidence paths. `merge.sh` reads the marker, so a PR without a passing record on its head cannot be merged.

A small change that needs no independent reviewers (docs, a one-line fix) still gets one round: the lead's own review, recorded with the reviewer named as `lead` and what was checked. The record says who reviewed, never that more happened than did.

The PR body lists the rounds (number, head, verdict) once the PR passes.
